/**
 * I10 — Key backups survive any session_id, and never fail silently.
 *
 * A Megolm session_id is standard base64 (alphabet includes `/` and `+`).
 * Interpolated raw into an S3 key it can form a leading/trailing/doubled `/` —
 * an invalid object name that S3/MinIO reject (XMinioInvalidObjectName, 400) —
 * and the fire-and-forget backup was swallowed, so that session's key vanished
 * silently (undecryptable history on restore). The fix encodes the key segment
 * base64url; the envelope body keeps the raw session_id, which restore reads.
 *
 * This test asserts every presigned `keys/{uid}/live/` key is object-name-safe,
 * that the backup actually lands (a 400 would leave the prefix empty), and that
 * a fresh device restores from it. The object-name property holds for ALL
 * session_ids, so this passes deterministically on correct code; a real sid is
 * ~94% likely to contain a `/`/`+`, so a regression (raw sid in the key) is
 * caught with high probability. The colocated unit test (src/lib/paths.test.ts)
 * is the precise, fully-deterministic guard.
 *
 * See docs/scenarios/invariants/i10-key-backup-object-name-safe.md.
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
import { getCurrentUserId, listRemoteKeys, makeS3Client } from './helpers';

// One non-empty base64url segment under live/: no `//`, no leading/trailing
// slash, alphabet limited to base64url.
const SAFE_LIVE_KEY = /^keys\/[^/]+\/live\/[A-Za-z0-9_-]+$/;

test.describe('I10 — key backups survive any session_id', () => {
    test('every live key-backup key is object-name-safe; backup lands and restores', async ({
        browser,
    }) => {
        test.setTimeout(120_000);

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // Capture every keys/{uid}/live/ key Alice presigns — backupSessionKey
        // POSTs /v1/store/presign with the key in the body before the PUT.
        const liveKeys: string[] = [];
        alice.on('request', (req) => {
            if (new URL(req.url()).pathname !== '/v1/store/presign') return;
            try {
                const body = req.postDataJSON() as { key?: string };
                if (body?.key?.startsWith('keys/') && body.key.includes('/live/')) {
                    liveKeys.push(body.key);
                }
            } catch {
                // non-JSON body — ignore
            }
        });

        // ── Register both; Bob → Alice one message ───────────────────
        // Alice receives Bob's key share, adds the inbound session, and backs
        // up its key under keys/{aliceUid}/live/{base64url(session_id)}.
        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);

        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'history-survives');
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'history-survives');

        // ── Remote: the backup landed (a 400 would leave the prefix empty) ──
        // Poll the whole keys/ prefix — sync may compact live → archive.
        const s3 = makeS3Client();
        await expect
            .poll(
                async () =>
                    (await listRemoteKeys(s3, `keys/${aliceUid}/`)).length,
                { timeout: 20_000 },
            )
            .toBeGreaterThan(0);

        // ── Every presigned live key was object-name-safe ────────────
        expect(
            liveKeys.length,
            'Alice presigned at least one live key backup',
        ).toBeGreaterThan(0);
        for (const k of liveKeys) {
            expect(k, k).toMatch(SAFE_LIVE_KEY);
            expect(k.includes('//'), `no doubled slash in ${k}`).toBe(false);
        }

        await aliceCtx.close();
        await bobCtx.close();

        // ── UI/Local: fresh device restores from the base64url-keyed blob ──
        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await loginUser(fresh, aliceHandle, E2E_PASSWORD);
        await openChat(fresh, bobHandle);
        await waitForMessage(fresh, 'history-survives');
        await freshCtx.close();
    });
});
