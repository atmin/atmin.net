/**
 * I1 — No duplicate visible messages
 *
 * Invariant: for any msg_id, every device shows at most one bubble,
 * holds at most one IDB row, and the live inbox prefix holds at most
 * one S3 object — under SSE delivery racing a concurrent sync, and
 * under a mid-sync page reload.
 */

import { expect, test } from '@playwright/test';
import {
    openChat,
    registerUser,
    registerUserWithMnemonic,
    sendMessage,
} from '../helpers';
import {
    buildConversationId,
    expectLocal,
    expectRemote,
    expectUI,
    getCurrentUserId,
    makeS3Client,
} from './helpers';

const BURST = 5;
// Must outlast all BURST sends + server round-trips so the delayed list
// fires only after every message is confirmed in S3. The single-syncer
// dedup absorbs concurrent SSE triggers into the in-flight promise; if
// the list fires too early it misses messages that arrive while sleeping
// and no follow-up fetch is queued.
const LIST_DELAY_MS = 3_000;

test.describe('I1 — no duplicate visible messages', () => {
    /**
     * Fault: Alice's /v1/store/list is delayed so Bob's SSE new_message
     * events arrive before the sync response. Both paths write to IDB;
     * the dedup guard must ensure only one row per msg_id.
     */
    test('SSE delivery races delayed sync — no duplicates', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Register ───────────────────────────────────────────
        const { handle: aliceHandle } = await registerUserWithMnemonic(alice);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);
        const bobUid = await getCurrentUserId(bob);
        const convId = buildConversationId(aliceUid, bobUid);

        // ── 2. Alice opens chat; initial sync + SSE settle ────────
        await openChat(alice, bobHandle);
        await alice.waitForSelector('text=No messages yet', {
            timeout: 15_000,
        });

        // ── 3. Delay Alice's list so SSE races the next sync ──────
        // When Bob sends, the server delivers SSE immediately. The
        // resulting fetchMessages call fires list — but list is slow.
        // Bob's send also triggers Alice's SSE handler to call
        // fetchMessages, which shares the in-flight promise. Both
        // ultimately resolve from one list response; the dedup guard
        // must not write duplicate IDB rows.
        let delaying = true;
        await alice.route('**/v1/store/list*', async (route) => {
            if (delaying) {
                await new Promise((r) => setTimeout(r, LIST_DELAY_MS));
            }
            return route.continue();
        });

        // ── 4. Bob sends burst while Alice's list is delayed ──────
        // Fire all sends without waiting for each to appear — waiting
        // between sends lets individual sync cycles complete, which can
        // advance Alice's cursor past later messages before they land.
        // Waiting only for button re-enablement keeps all SSE events
        // bunched together so one delayed list call picks up all BURST.
        await openChat(bob, aliceHandle);
        const sendBtn = bob.getByRole('button', { name: 'Send' });
        for (let i = 1; i <= BURST; i++) {
            await bob.getByPlaceholder('Type a message...').fill(`msg-${i}`);
            await expect(sendBtn).toBeEnabled({ timeout: 15_000 });
            await sendBtn.click();
        }
        // Confirm all sends completed on Bob's side before dropping the delay.
        await expect(bob.locator('[data-testid="message"]')).toHaveCount(
            BURST,
            { timeout: 30_000 },
        );

        // ── 5. Drop delay (in-flight handlers check the flag) ─────
        delaying = false;
        await expect(
            alice.locator('[data-testid="message"]'),
        ).toHaveCount(BURST, { timeout: 30_000 });

        // ── 6. Three-layer assertions ─────────────────────────────
        await expectUI(alice, {
            messageCount: BURST,
            messageTexts: Array.from({ length: BURST }, (_, i) => `msg-${i + 1}`),
        });

        await expectLocal(alice, convId, {
            uniqueMsgIdCount: BURST,
            ordered: true,
        });

        const s3 = makeS3Client();
        const remote = await expectRemote(s3, aliceUid, {});
        expect(
            new Set(remote.liveMsgIds).size,
            'no duplicate keys in live inbox',
        ).toBe(remote.liveMsgIds.length);

        await aliceCtx.close();
        await bobCtx.close();
    });

    /**
     * Fault: Alice receives all messages via SSE (normal path), then
     * reloads. The fresh sync runs against the same S3 state; IDB
     * already has all rows. No duplicates should appear after the
     * reload's sync completes.
     */
    test('page reload after SSE delivery — no duplicates', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Register ───────────────────────────────────────────
        const { handle: aliceHandle } = await registerUserWithMnemonic(alice);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);
        const bobUid = await getCurrentUserId(bob);
        const convId = buildConversationId(aliceUid, bobUid);

        // ── 2. Alice opens chat (SSE live) ────────────────────────
        await openChat(alice, bobHandle);
        await alice.waitForSelector('text=No messages yet', {
            timeout: 15_000,
        });

        // ── 3. Bob sends burst — Alice receives via SSE ───────────
        await openChat(bob, aliceHandle);
        for (let i = 1; i <= BURST; i++) {
            await sendMessage(bob, `msg-${i}`);
        }
        await expect(
            alice.locator('[data-testid="message"]'),
        ).toHaveCount(BURST, { timeout: 30_000 });

        // ── 4. Alice reloads — triggers fresh sync from cursor ────
        // The sync will find 0 new objects (cursor already advanced),
        // so IDB should remain at exactly BURST rows.
        await alice.reload();
        await alice.waitForURL(`**/${bobHandle}`, { timeout: 15_000 });
        await expect(
            alice.locator('[data-testid="message"]'),
        ).toHaveCount(BURST, { timeout: 30_000 });

        // ── 5. Three-layer assertions ─────────────────────────────
        await expectUI(alice, {
            messageCount: BURST,
            messageTexts: Array.from({ length: BURST }, (_, i) => `msg-${i + 1}`),
        });

        await expectLocal(alice, convId, {
            uniqueMsgIdCount: BURST,
            ordered: true,
        });

        const s3 = makeS3Client();
        const remote = await expectRemote(s3, aliceUid, {});
        expect(
            new Set(remote.liveMsgIds).size,
            'no duplicate keys in live inbox',
        ).toBe(remote.liveMsgIds.length);

        await aliceCtx.close();
        await bobCtx.close();
    });
});
