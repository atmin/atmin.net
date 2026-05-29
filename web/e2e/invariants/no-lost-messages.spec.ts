/**
 * I2 — No lost messages under fault
 *
 * A send that reaches committed remote state (200 on POST /v1/send) must
 * become visible to the recipient exactly once — even when the realtime
 * path is down, the recipient's first list fails, or the *sender* sees a
 * 5xx after the server already committed (ambiguous success). The last case
 * is why POST /v1/send retries idempotently on the same msg_id (api.ts):
 * the server overwrites per msg_id, so a retry can't duplicate.
 *
 * The rejected-send half of I2 ("a rejected send must not appear as sent")
 * overlaps I5 (send outcomes) and is asserted there.
 *
 * See docs/scenarios/invariants/i2-no-lost-messages.md.
 */

import { expect, test } from '@playwright/test';
import {
    getMessageCount,
    openChat,
    registerUser,
    registerUserWithPassword,
    resyncChat,
    sendMessage,
} from '../helpers';
import {
    buildConversationId,
    expectLocal,
    expectUI,
    getCurrentUserId,
    listRemoteKeys,
    makeS3Client,
} from './helpers';

test.describe('I2 — no lost messages under fault', () => {
    test('SSE drop: a committed send is delivered exactly once via reconcile', async ({
        browser,
    }) => {
        test.setTimeout(120_000);

        // Alice's realtime channel is dead for the whole session: every
        // EventSource connection aborts, and onerror just closes it (no
        // reconnect, no sync). Delivery must fall back to the mount/nav sync.
        const aliceCtx = await browser.newContext();
        await aliceCtx.route('**/v1/events**', (route) => route.abort());
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);
        const bobUid = await getCurrentUserId(bob);
        const convId = buildConversationId(aliceUid, bobUid);

        // Alice is viewing the chat; her initial mount-sync has already run.
        await openChat(alice, bobHandle);
        await openChat(bob, aliceHandle);

        // Bob sends while Alice has no realtime channel.
        await sendMessage(bob, 'held-until-reconcile');

        // With SSE dead, nothing pushed it to Alice — give it a beat, then
        // confirm it has NOT arrived yet (the fault is real).
        await alice.waitForTimeout(1500);
        expect(await getMessageCount(alice)).toBe(0);

        // Reconcile: navigating re-mounts the chat → a fresh sync fetches it.
        await resyncChat(alice, bobHandle);

        await expectUI(alice, {
            messageCount: 1,
            messageTexts: ['held-until-reconcile'],
        });
        await expectLocal(alice, convId, {
            uniqueMsgIdCount: 1,
            ordered: true,
        });
        // Remote: no duplicate keys in the live inbox prefix.
        const s3 = makeS3Client();
        const liveKeys = await listRemoteKeys(s3, `inbox/${aliceUid}/live/`);
        expect(new Set(liveKeys).size).toBe(liveKeys.length);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('ambiguous success: server commits, sender sees 5xx, idempotent retry → exactly once', async ({
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

        // Fault Bob's FIRST POST /v1/send: let it reach the server (which
        // commits the envelope) but return 502 to the client. The client's
        // idempotent retry reuses the same msg_id → the server overwrites,
        // so the recipient must still see exactly one copy.
        let faulted = false;
        await bob.route('**/v1/send', async (route) => {
            if (!faulted && route.request().method() === 'POST') {
                faulted = true;
                await route.fetch(); // hits the server → envelope committed
                await route.fulfill({
                    status: 502,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        error: 'internal',
                        message: 'injected ambiguous success',
                    }),
                });
                return;
            }
            await route.continue();
        });

        // sendMessage waits for Bob's own bubble — which only renders once
        // send() resolves, i.e. after the retry succeeds.
        await sendMessage(bob, 'committed-once');
        expect(faulted, 'the fault was actually injected').toBe(true);

        await resyncChat(alice, bobHandle);
        await expectUI(alice, {
            messageCount: 1,
            messageTexts: ['committed-once'],
        });
        await expectLocal(alice, convId, {
            uniqueMsgIdCount: 1,
            ordered: true,
        });

        const s3 = makeS3Client();
        const liveKeys = await listRemoteKeys(s3, `inbox/${aliceUid}/live/`);
        expect(
            new Set(liveKeys).size,
            'no duplicate inbox object despite the retry',
        ).toBe(liveKeys.length);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('transient list failure: the message is not lost, just deferred to the next sync', async ({
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

        // Let Alice's initial mount-sync settle first, THEN arm a one-shot
        // failure so it lands on the post-send sync, not the (empty) mount one.
        await openChat(alice, bobHandle);
        await openChat(bob, aliceHandle);
        await alice.waitForTimeout(1000);

        let failsLeft = 1;
        await alice.route('**/v1/store/list**', async (route) => {
            if (failsLeft > 0) {
                failsLeft -= 1;
                await route.abort();
                return;
            }
            await route.continue();
        });

        await sendMessage(bob, 'survives-list-failure');

        // Alice's next sync (SSE hint) hits the aborted list and recovers
        // nothing; syncAndPublish swallows the error. A later sync succeeds.
        await alice.waitForTimeout(1500);
        await resyncChat(alice, bobHandle);

        await expectUI(alice, {
            messageCount: 1,
            messageTexts: ['survives-list-failure'],
        });
        await expectLocal(alice, convId, {
            uniqueMsgIdCount: 1,
            ordered: true,
        });
        expect(failsLeft, 'the list failure was actually consumed').toBe(0);

        await aliceCtx.close();
        await bobCtx.close();
    });
});
