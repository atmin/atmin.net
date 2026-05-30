/**
 * I5 — Send outcomes are unambiguous
 *
 * Every send resolves into exactly one of { sent, rejected }, and the three
 * layers agree:
 *  - accepted → UI shows it sent, Local has a row, and it's reachable by the
 *    recipient's normal sync;
 *  - rejected → no row, no reachable Remote object, UI surfaces the failure.
 *
 * There is no "ghost sent": the sender's bubble renders only after send()
 * resolves and the self-addressed envelope syncs back (useChatSend), so a
 * failed send never leaves a sent-looking row.
 *
 * Note: a transient 5xx is retried to success (see I2); a 5xx *after* the
 * server committed is the ambiguous-success case I2 covers via idempotent
 * retry (the message is delivered, the sender just saw a failure) — that's
 * not a ghost-sent and is out of scope here. This spec covers the clean
 * rejection (server never accepts the write) and the offline gate.
 *
 * See docs/scenarios/invariants/i5-send-outcomes.md.
 */

import { expect, test } from '@playwright/test';
import {
    openChat,
    registerUser,
    registerUserWithPassword,
    sendMessage,
    waitForMessage,
} from '../helpers';
import {
    buildConversationId,
    expectLocal,
    getCurrentUserId,
    listRemoteKeys,
    makeS3Client,
} from './helpers';

test.describe('I5 — send outcomes are unambiguous', () => {
    test('accepted: the message agrees across UI, Local, and the recipient inbox', async ({
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

        await openChat(alice, bobHandle);
        await sendMessage(alice, 'delivered'); // waits for the sender's own echo

        // UI: shown as sent. Local: a row exists.
        await expectLocal(alice, convId, {
            uniqueMsgIdCount: 1,
            ordered: true,
        });
        // Remote: reachable by the recipient's normal sync.
        await openChat(bob, aliceHandle);
        await waitForMessage(bob, 'delivered');

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('rejected: a send the server never accepts leaves no trace at any layer', async ({
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

        await openChat(alice, bobHandle);

        // /v1/send never reaches the server → send() exhausts its retries and
        // throws → the UI alerts and renders nothing; nothing is committed.
        await alice.route('**/v1/send', (route) => route.abort());
        let dialogFired = false;
        alice.on('dialog', (d) => {
            dialogFired = true;
            d.dismiss();
        });

        await alice.getByPlaceholder('Type a message...').fill('never-lands');
        await alice.getByRole('button', { name: 'Send' }).click();

        await expect.poll(() => dialogFired, { timeout: 30_000 }).toBe(true);

        // UI: not shown as sent.
        await expect(alice.locator('[data-testid="message"]')).toHaveCount(0);
        // Local: no row.
        await expectLocal(alice, convId, { uniqueMsgIdCount: 0 });
        // Remote: nothing reachable in either inbox.
        const s3 = makeS3Client();
        expect(
            await listRemoteKeys(s3, `inbox/${bobUid}/live/`),
            'recipient inbox untouched',
        ).toEqual([]);
        expect(
            await listRemoteKeys(s3, `inbox/${aliceUid}/live/`),
            'no self-copy committed',
        ).toEqual([]);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('offline: sending is gated, never producing a ghost', async ({
        browser,
    }) => {
        test.setTimeout(90_000);

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        await registerUserWithPassword(alice);
        const bobHandle = await registerUser(bob);
        const bobUid = await getCurrentUserId(bob);

        await openChat(alice, bobHandle);
        await aliceCtx.setOffline(true);

        // Composer reflects offline; the Send button is disabled.
        await expect(alice.getByPlaceholder('You are offline')).toBeVisible({
            timeout: 15_000,
        });
        await expect(
            alice.getByRole('button', { name: 'Send' }),
        ).toBeDisabled();

        // No message rendered, no Remote object created.
        await expect(alice.locator('[data-testid="message"]')).toHaveCount(0);
        const s3 = makeS3Client();
        expect(await listRemoteKeys(s3, `inbox/${bobUid}/live/`)).toEqual([]);

        await aliceCtx.close();
        await bobCtx.close();
    });
});
