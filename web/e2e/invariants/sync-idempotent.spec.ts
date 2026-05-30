/**
 * I8 — Sync is idempotent
 *
 * Re-running sync with the cursor unchanged (no new remote objects) changes
 * nothing observable: same messages in the same order (UI + Local), and the
 * inbox's live/archive object sets are untouched — no message re-processed
 * into a duplicate, no spurious re-compaction.
 *
 * `useInboxSync` is mounted once at the app level, so navigation doesn't
 * re-run `fetchMessages`; a full page reload does (re-mount → syncAndPublish).
 * Each reload is a real sync pass that, thanks to the persisted cursor, finds
 * nothing new — which is exactly the idempotency under test.
 *
 * Out of scope (per the invariant's carve-out): background `keys/` writes
 * (session-key backup/rotation) may change without violating this — only the
 * message and conversation layers are asserted.
 *
 * See docs/scenarios/invariants/i8-sync-idempotent.md.
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
    expectUI,
    getCurrentUserId,
    inboxArchiveEnvelopes,
    listRemoteKeys,
    makeS3Client,
} from './helpers';

test.describe('I8 — sync is idempotent', () => {
    test('re-syncing with no new messages changes nothing at any layer', async ({
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
        const msgs = ['s1', 's2', 's3'];
        for (const text of msgs) await sendMessage(bob, text);
        await waitForMessage(alice, 's3');

        // Settle: messages compacted into the archive, live drained.
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

        // ── Baseline across all three layers ──────────────────────────
        await expectUI(alice, {
            messageCount: msgs.length,
            messageTexts: msgs,
        });
        const baseLocal = (
            await expectLocal(alice, convId, {
                uniqueMsgIdCount: msgs.length,
                ordered: true,
            })
        ).ids;
        const baseArchive = (
            await listRemoteKeys(s3, `inbox/${aliceUid}/archive/`)
        ).sort();

        // ── Re-sync K times via full reloads; assert nothing moves ────
        // Reload preserves the /@handle URL, so the chat re-mounts and a
        // fresh syncAndPublish runs on each pass.
        for (let i = 1; i <= 3; i++) {
            await alice.reload();
            await expectUI(alice, {
                messageCount: msgs.length,
                messageTexts: msgs,
            });

            // expectUI resolves from cached IDB, but the mount sync is
            // fire-and-forget and only fires once sessionManager re-inits
            // (WASM + key restore). Give that pass time to fully complete, so
            // a (hypothetical) non-idempotent write would have landed before
            // we assert it didn't. Generous on purpose; CI may need more.
            await alice.waitForTimeout(4000);

            const local = (
                await expectLocal(alice, convId, {
                    uniqueMsgIdCount: msgs.length,
                    ordered: true,
                })
            ).ids;
            expect(local, `Local unchanged after re-sync #${i}`).toEqual(
                baseLocal,
            );

            expect(
                await listRemoteKeys(s3, `inbox/${aliceUid}/live/`),
                `live still empty after re-sync #${i}`,
            ).toEqual([]);
            expect(
                (await listRemoteKeys(s3, `inbox/${aliceUid}/archive/`)).sort(),
                `no new/changed archive object after re-sync #${i}`,
            ).toEqual(baseArchive);
        }

        await aliceCtx.close();
        await bobCtx.close();
    });
});
