/**
 * I6 — Bad credential / corrupt backup fails legibly
 *
 * Two distinct, non-silent failure modes:
 *  - Wrong password → login is rejected; no session is established.
 *  - Correct password against a corrupted key-backup blob → login still
 *    succeeds (one bad blob must not block everything), restore skips the
 *    blob, COUNTS it, and surfaces a visible "couldn't be restored" signal.
 *
 * The second half is the load-bearing one: before this, a corrupt blob was
 * silently dropped (console.error only), so history could vanish with no
 * user-facing trace. See docs/scenarios/invariants/i6-bad-credential-corrupt-backup.md.
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
    corruptKeyBackups,
    getCurrentUserId,
    listRemoteKeys,
    makeS3Client,
} from './helpers';

test.describe('I6 — bad credential / corrupt backup fails legibly', () => {
    test('wrong password is rejected; no session established', async ({
        browser,
    }) => {
        // Argon2id on the wrong password + the add-device round trip.
        test.setTimeout(90_000);

        const aliceCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const { handle } = await registerUserWithPassword(alice);
        await aliceCtx.close();

        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await fresh.goto('/login');
        await fresh.fill('#handle', handle);
        await fresh.fill('#secret', 'definitely-not-the-password-9');
        await fresh.getByRole('button', { name: 'Sign In' }).click();

        // Wrong password derives the wrong auth key, so add-device's auth
        // proof fails verification → 403 → the form shows a "Login failed"
        // error and stays on /login. No redirect, no session.
        await expect(fresh.getByText(/login failed/i)).toBeVisible({
            timeout: 60_000,
        });
        expect(fresh.url()).toContain('/login');
        const persistedUid = await fresh.evaluate(() =>
            localStorage.getItem('atmin:userId'),
        );
        expect(persistedUid, 'no session persisted on failed login').toBeNull();

        await freshCtx.close();
    });

    test('correct password + corrupt key-backup blob → login succeeds with a visible restore warning', async ({
        browser,
    }) => {
        test.setTimeout(120_000);

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Register both; Bob → Alice one message ────────────────
        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);

        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'hello');
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'hello');

        // ── 2. Wait until Alice's inbound session key is backed up ────
        // It lands in keys/{uid}/live/ but Alice's sync compacts that prefix
        // into a keys/{uid}/archive/ CBOR bundle — so poll the WHOLE prefix,
        // not just live/, or we race compaction.
        const s3 = makeS3Client();
        await expect
            .poll(
                async () =>
                    (await listRemoteKeys(s3, `keys/${aliceUid}/`)).length,
                { timeout: 20_000 },
            )
            .toBeGreaterThan(0);

        // Close the original devices and let any in-flight compaction settle
        // so the blob set is stable before we corrupt it.
        await aliceCtx.close();
        await bobCtx.close();
        await new Promise((r) => setTimeout(r, 500));

        // ── 3. Corrupt every key-backup blob under Alice's prefix ─────
        // Whether the session key sits in a live/ JSON envelope or an
        // archive/ CBOR bundle, mangle its ciphertext while keeping the
        // envelope shape valid ({v, iv, ciphertext}) — so it parses, reaches
        // AES-GCM, and fails the auth tag → counted as a failed restore
        // (not a parse/decode error), which is what surfaces the warning.
        const corrupted = await corruptKeyBackups(s3, aliceUid);
        expect(
            corrupted,
            'at least one key-backup blob to corrupt',
        ).toBeGreaterThan(0);

        // ── 4. Fresh device, CORRECT password ────────────────────────
        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await loginUser(fresh, aliceHandle, E2E_PASSWORD); // resolves on home → login succeeded

        // ── 5. Login succeeded, and the loss is surfaced, not silent ─
        const warning = fresh.getByTestId('restore-warning');
        await expect(warning).toBeVisible({ timeout: 30_000 });
        await expect(warning).toContainText(/couldn't be restored/i);
        // Client is still functional — the warning is dismissible.
        await fresh.getByRole('button', { name: 'Dismiss' }).click();
        await expect(warning).toBeHidden();

        await freshCtx.close();
    });
});
