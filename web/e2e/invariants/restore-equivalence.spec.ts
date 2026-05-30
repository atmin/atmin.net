/**
 * I4 — Restore-equivalence across devices
 *
 * A second device added after history has accumulated (and compacted into an
 * archive) converges to the same ordered, decryptable message set as the
 * first device — without manual intervention — and a message sent after the
 * join reaches both. The two devices share the password-derived backup key
 * (ADR-0002: user-level sharing key, no per-device re-share), so device 2
 * restores the inbound session keys from the backup and decrypts history it
 * never received live.
 *
 * See docs/scenarios/invariants/i4-restore-equivalence.md.
 */

import { expect, test } from '@playwright/test';
import {
    E2E_PASSWORD,
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    sendMessage,
    waitForMessage,
} from '../helpers';
import {
    buildConversationId,
    expectLocal,
    expectUI,
    getCurrentUserId,
    inboxArchiveEnvelopes,
    makeS3Client,
} from './helpers';

test.describe('I4 — restore-equivalence across devices', () => {
    test('a device added after archives exist converges to the same set; a post-join message reaches both', async ({
        browser,
    }) => {
        test.setTimeout(180_000);

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice1 = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(alice1);
        const aliceUid = await getCurrentUserId(alice1);
        const bobHandle = await registerUser(bob);
        const bobUid = await getCurrentUserId(bob);
        const convId = buildConversationId(aliceUid, bobUid);

        // ── 1. Accumulate history; Alice's sync compacts it into an archive ─
        await openChat(bob, aliceHandle);
        await openChat(alice1, bobHandle);
        const history = ['m1', 'm2', 'm3'];
        for (const text of history) await sendMessage(bob, text);
        await waitForMessage(alice1, 'm3');

        const s3 = makeS3Client();
        await expect
            .poll(
                async () => (await inboxArchiveEnvelopes(s3, aliceUid)).length,
                {
                    timeout: 20_000,
                },
            )
            .toBeGreaterThan(0);

        // ── 2. Add device 2 AFTER the archive exists → it must restore from it ─
        const alice2Ctx = await browser.newContext();
        const alice2 = await alice2Ctx.newPage();
        await loginUser(alice2, aliceHandle, E2E_PASSWORD);
        await openChat(alice2, bobHandle);

        // ── 3. Both devices hold the identical ordered, decryptable set ─────
        await expectUI(alice1, {
            messageCount: history.length,
            messageTexts: history,
        });
        await expectUI(alice2, {
            messageCount: history.length,
            messageTexts: history,
        });
        const d1 = await expectLocal(alice1, convId, {
            uniqueMsgIdCount: history.length,
            ordered: true,
        });
        const d2 = await expectLocal(alice2, convId, {
            uniqueMsgIdCount: history.length,
            ordered: true,
        });
        expect(d2.ids, 'device 2 holds the identical msg_id list').toEqual(
            d1.ids,
        );

        // ── 4. A message sent after the join reaches BOTH devices ───────────
        await sendMessage(bob, 'after-join');
        await waitForMessage(alice1, 'after-join');
        await waitForMessage(alice2, 'after-join');

        const all = [...history, 'after-join'];
        await expectUI(alice1, { messageCount: all.length, messageTexts: all });
        await expectUI(alice2, { messageCount: all.length, messageTexts: all });
        const f1 = await expectLocal(alice1, convId, {
            uniqueMsgIdCount: all.length,
            ordered: true,
        });
        const f2 = await expectLocal(alice2, convId, {
            uniqueMsgIdCount: all.length,
            ordered: true,
        });
        expect(
            f2.ids,
            'both devices still converge after the live message',
        ).toEqual(f1.ids);

        await aliceCtx.close();
        await alice2Ctx.close();
        await bobCtx.close();
    });
});
