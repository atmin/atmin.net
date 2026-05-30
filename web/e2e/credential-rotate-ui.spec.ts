import { expect, test } from '@playwright/test';
import {
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    resyncChat,
    sendMessage,
    waitForMessage,
} from './helpers';

const NEW_PASSWORD = 'rotated-passphrase-strong-2';
const ROTATION_TIMEOUT_MS = 45_000;

test.describe('Credential rotation (Change password)', () => {
    test('rotates, keeps the current session working, and decrypts pre-rotation history on re-login', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Register Alice + Bob; Alice keeps her original password ──
        const { handle: aliceHandle, password: oldPassword } =
            await registerUserWithPassword(alice);
        const bobHandle = await registerUser(bob);

        // ── 2. Bob → Alice "note 1" (pre-rotation history) ──────────────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'note 1');
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'note 1');

        // ── 3. Open settings, enter the WRONG current password ──────────
        await alice.goto('/settings');
        await alice.waitForSelector('#current-password', { timeout: 15_000 });
        await alice.fill('#current-password', 'this-is-not-my-password');
        await alice.fill('#new-password', NEW_PASSWORD);
        await alice.fill('#confirm-new-password', NEW_PASSWORD);

        // Radix Checkbox renders as <button role="checkbox">; setChecked
        // is Playwright's checkbox-aware API and works on ARIA roles too.
        // Assert the final state so we fail fast if the toggle didn't take.
        const ack = alice.getByRole('checkbox', { name: /unrecoverable/i });
        await ack.setChecked(true);
        await expect(ack).toBeChecked({ timeout: 5_000 });

        const submit = alice.getByTestId('change-password-submit');
        // Fail fast if `canSubmit` is still false, rather than burning the
        // 30 s actionability wait on a disabled-button click.
        await expect(submit).toBeEnabled({ timeout: 5_000 });
        await submit.click();

        await expect(alice.getByText(/is incorrect/i)).toBeVisible({
            timeout: ROTATION_TIMEOUT_MS,
        });

        // ── 4. Enter the correct current + new password and submit ─────
        await alice.fill('#current-password', oldPassword);
        // The other fields and the checkbox stayed populated; submit again.
        await expect(submit).toBeEnabled({ timeout: 5_000 });
        await submit.click();

        // Done step shows briefly; we just need the form to reset.
        await expect(alice.getByText('✓ Password changed')).toBeVisible({
            timeout: ROTATION_TIMEOUT_MS,
        });

        // ── 5. Post-rotation exchange. Bob is still on /{aliceHandle}, so
        // we send directly without re-opening the chat; useChatSend
        // re-resolves Alice on every send (ADR-0012 — Contact sharing-key
        // refresh), so the new ECIES key share — if any — picks up her
        // current sharing_public_key. Alice is on /settings, so resync
        // back to the Bob chat before asserting note 2 arrived.
        await sendMessage(bob, 'note 2');
        await resyncChat(alice, bobHandle);
        await waitForMessage(alice, 'note 2');

        // ── 6. Sign in with the NEW password on a fresh context (clean IDB).
        // Proves the chain-walker recovers the v1 backup key for "note 1"
        // on a device that never held the old key material, and the
        // post-rotation "note 2" decrypts too.
        const aliceFreshCtx = await browser.newContext();
        const aliceFresh = await aliceFreshCtx.newPage();
        await loginUser(aliceFresh, aliceHandle, NEW_PASSWORD);

        await openChat(aliceFresh, bobHandle);
        // Fresh device: re-derive (Argon2id) + restore + chain-walk + decrypt
        // before "note 1" renders — beyond the 15s live-delivery default.
        await waitForMessage(aliceFresh, 'note 1', 30_000);
        await waitForMessage(aliceFresh, 'note 2', 30_000);

        // ── 7. The OLD password no longer works ─────────────────────────
        const stalenessCtx = await browser.newContext();
        const stalenessPage = await stalenessCtx.newPage();
        await stalenessPage.goto('/login');
        await stalenessPage.fill('#handle', aliceHandle);
        await stalenessPage.fill('#secret', oldPassword);
        await stalenessPage
            .getByRole('button', { name: 'Sign In' })
            .click();
        // The derived auth key no longer matches profile.auth_public_key;
        // the server's add-device verification will reject. We assert the
        // page stays on /login or shows an error rather than landing on /.
        await expect(stalenessPage).toHaveURL(/\/login/, {
            timeout: ROTATION_TIMEOUT_MS,
        });

        await aliceCtx.close();
        await bobCtx.close();
        await aliceFreshCtx.close();
        await stalenessCtx.close();
    });
});
