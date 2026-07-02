/**
 * I12 — Concurrent same-account clients converge
 *
 * Two devices of one account are online at once while their shared inbox
 * fills. Both sync and may compact concurrently — the server holds no
 * per-uid compaction mutex, so overlapping archive bundles are a legal
 * outcome — and every layer must still end exactly-once. Test 1 drives the
 * natural race between two devices; test 2 constructs the worst legal
 * footprint (one msg_id in two bundles) by hand and proves a fresh device
 * absorbs it.
 *
 * (The shared-IndexedDB, single-context two-tab cursor race that
 * inbox-sync.ts documents is a narrower client-only concern; it needs a
 * two-tab harness and is left as a follow-on.)
 *
 * See docs/scenarios/invariants/i12-concurrent-sync.md.
 */

import { expect, test } from '@playwright/test';
import { decode as cborDecode, encode as cborEncode } from 'cbor-x';
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
    getObjectBytes,
    inboxArchiveEnvelopes,
    listRemoteKeys,
    makeS3Client,
    putObject,
} from './helpers';

test.describe('I12 — concurrent same-account clients converge', () => {
    test('two devices sync and compact the same inbox at once — exactly once at every layer', async ({
        browser,
    }) => {
        test.setTimeout(180_000);

        const device1Ctx = await browser.newContext();
        const device2Ctx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const d1 = await device1Ctx.newPage();
        const d2 = await device2Ctx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(d1);
        const aliceUid = await getCurrentUserId(d1);
        const bobHandle = await registerUser(bob);
        const bobUid = await getCurrentUserId(bob);
        const convId = buildConversationId(aliceUid, bobUid);

        // Alice's second device on the same account — its own IndexedDB and
        // sync cursor, the same S3 inbox.
        await loginUser(d2, aliceHandle, E2E_PASSWORD);

        // Both devices sit in the chat, online, while Bob bursts. Whichever
        // device's post-sync compaction fires first deletes the live objects
        // out from under the other's in-flight sync.
        await openChat(bob, aliceHandle);
        await openChat(d1, bobHandle);
        await openChat(d2, bobHandle);

        const burst = ['c1', 'c2', 'c3', 'c4', 'c5'];
        for (const text of burst) await sendMessage(bob, text);

        // Both devices converge to the full set, exactly once, in order.
        const s3 = makeS3Client();
        for (const d of [d1, d2]) {
            await expectUI(d, {
                messageCount: burst.length,
                messageTexts: burst,
                timeout: 30_000,
            });
            await expectLocal(d, convId, {
                uniqueMsgIdCount: burst.length,
                ordered: true,
            });
        }

        // Compaction drains live/ — poll until empty (a live object may vanish
        // only into some archive bundle, never into nothing).
        await expect
            .poll(
                async () =>
                    (await listRemoteKeys(s3, `inbox/${aliceUid}/live/`))
                        .length,
                { timeout: 30_000 },
            )
            .toBe(0);

        // Every msg_id the devices hold survived into the archive union…
        const local = await expectLocal(d1, convId, {});
        const archivedIds = new Set(
            (await inboxArchiveEnvelopes(s3, aliceUid)).map((e) => e.msg_id),
        );
        for (const id of local.ids) {
            expect(
                archivedIds.has(id),
                `msg_id ${id} survived compaction into some bundle`,
            ).toBe(true);
        }

        // …and each bundle is internally duplicate-free (I1's strict scope —
        // duplication *across* bundles is the permitted concurrent-compaction
        // artifact, absorbed by client dedup).
        for (const key of await listRemoteKeys(s3, `inbox/${aliceUid}/archive/`)) {
            const entries = cborDecode(
                await getObjectBytes(s3, key),
            ) as Array<{ msg_id: string }>;
            const ids = entries.map((e) => e.msg_id);
            expect(
                new Set(ids).size,
                `bundle ${key} is internally duplicate-free`,
            ).toBe(ids.length);
        }

        // A fresh device replays whatever bundle layout the race produced:
        // every message exactly once, in order.
        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await loginUser(fresh, aliceHandle, E2E_PASSWORD);
        await openChat(fresh, bobHandle);
        await expectUI(fresh, {
            messageCount: burst.length,
            messageTexts: burst,
            timeout: 30_000,
        });
        await expectLocal(fresh, convId, {
            uniqueMsgIdCount: burst.length,
            ordered: true,
        });

        await freshCtx.close();
        await device1Ctx.close();
        await device2Ctx.close();
        await bobCtx.close();
    });

    test('a msg_id duplicated across two archive bundles renders once on a fresh device', async ({
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
                { timeout: 20_000 },
            )
            .toBeGreaterThan(0);

        // Freeze Alice, then leave the exact footprint two racing compacts
        // can leave: the same message envelope in two sibling bundles.
        await aliceCtx.close();
        const bundleKeys = await listRemoteKeys(
            s3,
            `inbox/${aliceUid}/archive/`,
        );
        const source = bundleKeys[0];
        const entries = cborDecode(await getObjectBytes(s3, source)) as Array<
            Record<string, unknown> & { content_type: string }
        >;
        const message = entries.find(
            (e) => e.content_type === 'megolm.message',
        );
        expect(
            message,
            'an archived message envelope to duplicate',
        ).toBeTruthy();
        if (!message) return;
        const sibling =
            source.slice(0, -1) + (source.endsWith('A') ? 'B' : 'A');
        await putObject(s3, sibling, cborEncode([message]), 'application/cbor');

        // A fresh device walks both bundles and must show the message once.
        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await loginUser(fresh, aliceHandle, E2E_PASSWORD);
        await openChat(fresh, bobHandle);
        await expectUI(fresh, {
            messageCount: 1,
            messageTexts: ['solo'],
            timeout: 30_000,
        });
        await expectLocal(fresh, convId, {
            uniqueMsgIdCount: 1,
            ordered: true,
        });

        await freshCtx.close();
        await bobCtx.close();
    });
});
