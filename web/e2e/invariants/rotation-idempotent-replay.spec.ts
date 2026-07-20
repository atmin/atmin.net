/**
 * I16 — Rotation resolves exactly once under ambiguous failure
 *
 * Fault: the first POST /v1/rotate-keys is aborted *after* the client has
 * already appended its `{old→new}` chain link (wrapping the old key under a
 * fresh-salt K_a) but before the server commits. The user re-submits; a new
 * salt yields K_b, a second `{old→new}` link would be appended, and this POST
 * commits (server → new kv, device holds K_b).
 *
 * The confirmed bug (H1): if the chain forks — two colliding `{old→new}` links
 * — `resolveBackupKey` used to pick the first by array order (the abandoned
 * K_a link), fail to AES-GCM-decrypt it, and throw, never trying the committed
 * K_b link. Every pre-rotation era became undecryptable on every device.
 *
 * The fix is two guards, both asserted here end-to-end:
 *   1. `appendChainLink` dedups by `(from, to)` → the chain never forks
 *      ("no fork: exactly one link").
 *   2. `resolveBackupKey` tries every matching link and accepts the one that
 *      decrypts → a fresh device recovers every pre-rotation era.
 *
 * The replay-record path is deliberately *not* asserted: the web client mints a
 * fresh `request_id` per submit, so the retry is a new rotation, not a record
 * replay (see the invariant doc). The `409`-on-stale-kv leg is covered by the
 * handler unit tests (`rotate_contention_is_409_with_current_minus_one`).
 *
 * See docs/scenarios/invariants/i16-rotation-idempotent-replay.md.
 */

import { expect, test } from '@playwright/test';
import {
    E2E_PASSWORD,
    expectKonstaCheckboxChecked,
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    resyncChat,
    sendMessage,
    tickKonstaCheckbox,
    waitForMessage,
} from '../helpers';
import { expectUI, getCurrentUserId, getObject, makeS3Client } from './helpers';

const PW_2 = 'rotated-passphrase-strong-2';
const ROTATION_TIMEOUT_MS = 60_000;

test.describe('I16 — rotation resolves exactly once under ambiguous failure', () => {
    test('failed-then-retried rotation leaves one link; fresh device recovers every era', async ({
        browser,
    }) => {
        // Two Argon2id derivations for the (failed + retried) rotation plus a
        // fresh-device login; the default 60s budget is too tight on CI.
        test.setTimeout(180_000);

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Register Alice (kv=1) and Bob ─────────────────────────
        const { handle: aliceHandle, password: pw1 } =
            await registerUserWithPassword(alice);
        expect(pw1).toBe(E2E_PASSWORD);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);

        // ── 2. Era 1: Bob → Alice while Alice is at kv=1 ─────────────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'era-1');
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'era-1');

        // ── 3. Arm the fault: abort ONLY the first rotate-keys POST ──
        // The chain link is written before the POST (useRotateKeys step 3), so
        // aborting here leaves an orphan {1→2} link (K_a) in key_chain.json,
        // committing nothing server-side. The retry's POST is let through.
        let rotateAttempts = 0;
        await alice.route('**/v1/rotate-keys', async (route) => {
            rotateAttempts += 1;
            if (rotateAttempts === 1) {
                await route.abort('failed');
            } else {
                await route.continue();
            }
        });

        // ── 4. Change password kv=1 → kv=2: first submit fails, retry ─
        await alice.goto('/settings');
        await alice.getByTestId('change-password-trigger').click();
        await alice.waitForSelector('#current-password', { timeout: 15_000 });
        await alice.fill('#current-password', pw1);
        await alice.fill('#new-password', PW_2);
        await alice.fill('#confirm-new-password', PW_2);
        await tickKonstaCheckbox(alice, 'change-password-ack');
        await expectKonstaCheckboxChecked(alice, 'change-password-ack');

        const submit = alice.getByTestId('change-password-submit');
        await expect(submit).toBeEnabled({ timeout: 5_000 });
        await submit.click();

        // First attempt fails legibly and returns to the form (not a wedge).
        await expect(alice.getByText(/Rotation failed/)).toBeVisible({
            timeout: ROTATION_TIMEOUT_MS,
        });

        // Retry: fields + ack are retained on error, so re-submit directly.
        await expect(submit).toBeEnabled({ timeout: 5_000 });
        await submit.click();
        await expect(alice.getByText('✓ Password changed')).toBeVisible({
            timeout: ROTATION_TIMEOUT_MS,
        });
        expect(rotateAttempts, 'the first POST was aborted then retried').toBe(
            2,
        );

        // ── 5. Era 2: Bob → Alice while Alice is at kv=2 ─────────────
        await resyncChat(alice, bobHandle);
        await sendMessage(bob, 'era-2');
        await waitForMessage(alice, 'era-2');

        // ── 6. Load-bearing Remote assertion: NO FORK ───────────────
        // Exactly one {1→2} link survived the retry; the orphan K_a link was
        // deduped away by appendChainLink. Two links here is the brick-history
        // bug this spec guards.
        const s3 = makeS3Client();
        const chainObj = await getObject(s3, `keys/${aliceUid}/key_chain.json`);
        const chain = JSON.parse(chainObj) as {
            links: Array<{ from: number; to: number }>;
        };
        expect(chain.links.map((l) => [l.from, l.to])).toEqual([[1, 2]]);

        // ── 7. Fresh device with the NEW password recovers every era ─
        // Clean IDB: the walker must recover the kv=1 backup key from the one
        // surviving link (K_b) to decrypt the pre-rotation era. If it tried the
        // orphan link and threw, era-1 would never render — the H1 bug.
        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await loginUser(fresh, aliceHandle, PW_2);
        await openChat(fresh, bobHandle);

        await expectUI(fresh, {
            messageCount: 2,
            messageTexts: ['era-1', 'era-2'],
            timeout: 30_000,
        });

        await aliceCtx.close();
        await bobCtx.close();
        await freshCtx.close();
    });
});
