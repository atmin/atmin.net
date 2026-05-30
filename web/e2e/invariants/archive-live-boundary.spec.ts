/**
 * I3 — Archive/live boundary is consistent
 *
 * After compaction, every message is reachable through exactly one path:
 * no msg_id lives in both inbox/{uid}/live/ and an inbox/{uid}/archive/
 * bundle, nothing is dropped at the boundary, and a fresh device
 * reconstructs the complete set exactly once and in order. Re-syncing with
 * no new messages changes nothing.
 *
 * Compaction is a single server operation (archive-then-delete is internal),
 * so the literal "sync during an in-progress compaction" window can't be
 * caught from the client. We instead assert the post-compaction boundary
 * directly, and construct the transient live+archive overlap by hand to
 * prove the client's live-first dedup (seenMsgIds) absorbs it.
 *
 * See docs/scenarios/invariants/i3-archive-live-boundary.md.
 */

import { expect, test } from '@playwright/test';
import {
    E2E_PASSWORD,
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    resyncChat,
    sendMessage,
    waitForMessage,
} from '../helpers';
import {
    buildConversationId,
    expectLocal,
    expectUI,
    getCurrentUserId,
    inboxArchiveEnvelopes,
    listRemoteKeys,
    makeS3Client,
    putObject,
} from './helpers';

const liveMsgIds = (keys: string[]): string[] =>
    keys.map((k) => k.split('/').pop() ?? '');

test.describe('I3 — archive/live boundary is consistent', () => {
    test('every message in exactly one prefix; fresh device sees them all once; re-sync is idempotent', async ({
        browser,
    }) => {
        test.setTimeout(150_000);

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);
        const bobUid = await getCurrentUserId(bob);
        const convId = buildConversationId(aliceUid, bobUid);

        await openChat(bob, aliceHandle);
        await openChat(alice, bobHandle);

        // ── Batch 1: Alice receives → her sync compacts live → archive ─
        const batch1 = ['a1', 'a2', 'a3'];
        for (const text of batch1) await sendMessage(bob, text);
        await waitForMessage(alice, 'a3');

        const s3 = makeS3Client();
        await expect
            .poll(
                async () => (await inboxArchiveEnvelopes(s3, aliceUid)).length,
                {
                    timeout: 20_000,
                },
            )
            .toBeGreaterThan(0);
        await expect
            .poll(
                async () =>
                    (await listRemoteKeys(s3, `inbox/${aliceUid}/live/`))
                        .length,
                { timeout: 20_000 },
            )
            .toBe(0);

        // Freeze Alice's client so batch 2 stays in live/ (nothing compacts it).
        await aliceCtx.close();

        // ── Batch 2: lands in live/, post-boundary ────────────────────
        const batch2 = ['b1', 'b2'];
        for (const text of batch2) await sendMessage(bob, text);
        await expect
            .poll(
                async () =>
                    (await listRemoteKeys(s3, `inbox/${aliceUid}/live/`))
                        .length,
                { timeout: 20_000 },
            )
            .toBe(batch2.length);

        // ── Boundary: no msg_id appears in both live/ and archive/ ────
        const liveIds = liveMsgIds(
            await listRemoteKeys(s3, `inbox/${aliceUid}/live/`),
        );
        const archiveIds = (await inboxArchiveEnvelopes(s3, aliceUid)).map(
            (e) => e.msg_id,
        );
        const both = liveIds.filter((id) => archiveIds.includes(id));
        expect(both, 'no msg_id in both live and archive').toEqual([]);

        // ── Fresh device reconstructs the full set, once, in order ────
        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await loginUser(fresh, aliceHandle, E2E_PASSWORD);
        await openChat(fresh, bobHandle);

        const all = [...batch1, ...batch2];
        await expectUI(fresh, { messageCount: all.length, messageTexts: all });
        await expectLocal(fresh, convId, {
            uniqueMsgIdCount: all.length,
            ordered: true,
        });

        // ── Re-sync with no new messages changes nothing ─────────────
        await resyncChat(fresh, bobHandle);
        await expectUI(fresh, { messageCount: all.length, messageTexts: all });
        await expectLocal(fresh, convId, {
            uniqueMsgIdCount: all.length,
            ordered: true,
        });

        await bobCtx.close();
        await freshCtx.close();
    });

    test('client dedup absorbs a live+archive overlap (the in-flight compaction window)', async ({
        browser,
    }) => {
        test.setTimeout(120_000);

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);
        const bobUid = await getCurrentUserId(bob);
        const convId = buildConversationId(aliceUid, bobUid);

        await openChat(bob, aliceHandle);
        await openChat(alice, bobHandle);
        await sendMessage(bob, 'solo');
        await waitForMessage(alice, 'solo');

        const s3 = makeS3Client();
        await expect
            .poll(
                async () => (await inboxArchiveEnvelopes(s3, aliceUid)).length,
                {
                    timeout: 20_000,
                },
            )
            .toBeGreaterThan(0);

        // Freeze Alice's client, then recreate the overlap compaction holds
        // only transiently: put the archived message envelope back into live/
        // so the same msg_id now exists in BOTH prefixes.
        await aliceCtx.close();
        const message = (await inboxArchiveEnvelopes(s3, aliceUid)).find(
            (e) => e.content_type === 'megolm.message',
        );
        expect(
            message,
            'an archived message envelope to duplicate',
        ).toBeTruthy();
        if (!message) return;
        await putObject(
            s3,
            `inbox/${aliceUid}/live/${message.msg_id}`,
            JSON.stringify(message),
        );
        expect(
            liveMsgIds(await listRemoteKeys(s3, `inbox/${aliceUid}/live/`)),
            'overlap is in place',
        ).toContain(message.msg_id);

        // ── Fresh device must show it exactly once, not twice ─────────
        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await loginUser(fresh, aliceHandle, E2E_PASSWORD);
        await openChat(fresh, bobHandle);

        await expectUI(fresh, { messageCount: 1, messageTexts: ['solo'] });
        await expectLocal(fresh, convId, {
            uniqueMsgIdCount: 1,
            ordered: true,
        });

        await bobCtx.close();
        await freshCtx.close();
    });
});
