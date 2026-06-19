import { expect, test } from '@playwright/test';
import {
    expectKonstaCheckboxChecked,
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    sendMessage,
    tickKonstaCheckbox,
    waitForChatList,
    waitForMessage,
} from './helpers';

const NEW_PASSWORD = 'rotated-passphrase-strong-2';
const ROTATION_TIMEOUT_MS = 45_000;

test.describe('Credential rotation — multi-device cutoff', () => {
    // Argon2id-heavy (register + login second device + rotate + re-login):
    // triple the default timeout to absorb machine load.
    test.beforeEach(() => test.slow());

    test('rotation on device A forces device B to /login with the notice; re-login restores history', async ({
        browser,
    }) => {
        const ctxA = await browser.newContext();
        const ctxB = await browser.newContext();
        const ctxBob = await browser.newContext();
        const a = await ctxA.newPage();
        const b = await ctxB.newPage();
        const bob = await ctxBob.newPage();

        // ── 1. Alice registers on device A; logs in on device B with the
        //      same password. Both contexts hold valid tokens at kv=1. ──
        const { handle: aliceHandle, password: oldPassword } =
            await registerUserWithPassword(a);
        await loginUser(b, aliceHandle, oldPassword);

        // ── 2. Bob → Alice "msg 1": pre-rotation history both contexts see ──
        const bobHandle = await registerUser(bob);
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'msg 1');
        await openChat(a, bobHandle);
        await waitForMessage(a, 'msg 1');
        await openChat(b, bobHandle);
        await waitForMessage(b, 'msg 1');

        // ── 3. Alice rotates her password on device A ───────────────────
        await a.goto('/settings');
        // Change password is a Konsta Sheet (ADR-0023/T2) — open it first.
        await a.getByTestId('change-password-trigger').click();
        await a.waitForSelector('#current-password', { timeout: 15_000 });
        await a.fill('#current-password', oldPassword);
        await a.fill('#new-password', NEW_PASSWORD);
        await a.fill('#confirm-new-password', NEW_PASSWORD);
        await tickKonstaCheckbox(a, 'change-password-ack');
        await expectKonstaCheckboxChecked(a, 'change-password-ack');
        const submit = a.getByTestId('change-password-submit');
        await expect(submit).toBeEnabled({ timeout: 5_000 });
        await submit.click();
        await expect(a.getByText('✓ Password changed')).toBeVisible({
            timeout: ROTATION_TIMEOUT_MS,
        });

        // ── 4. Device B navigates somewhere that issues an authenticated
        //      request. useDevices on /settings calls storeList; the server
        //      sees the kv=1 token and returns 401 key_version_stale. The
        //      api layer emits the event, useSession wipes IDB + state, and
        //      the route's session-null branch navigates to /login. ─────
        await b.goto('/settings');

        // ── 5. /login is reached and the cutoff notice is visible ───────
        await expect(b).toHaveURL(/\/login/, {
            timeout: ROTATION_TIMEOUT_MS,
        });
        await expect(b.getByTestId('login-notice')).toBeVisible({
            timeout: 5_000,
        });

        // ── 6. The old password is no longer accepted ───────────────────
        await b.fill('#handle', aliceHandle);
        await b.fill('#secret', oldPassword);
        await b.getByRole('button', { name: 'Sign In' }).click();
        // Filling the handle dismissed the notice on first interaction.
        await expect(b.getByTestId('login-notice')).toHaveCount(0);
        // The derived auth key won't match profile.auth_public_key.
        await expect(b).toHaveURL(/\/login/, { timeout: ROTATION_TIMEOUT_MS });

        // ── 7. The new password works on B (clean IDB) ──────────────────
        await b.fill('#secret', NEW_PASSWORD);
        await b.getByRole('button', { name: 'Sign In' }).click();
        await waitForChatList(b);

        // ── 8. History from before the rotation still decrypts on B
        //      (chain walk recovers the v1 backup key from key_chain.json),
        //      and post-rotation messages flow. ──────────────────────────
        await openChat(b, bobHandle);
        await waitForMessage(b, 'msg 1');
        await sendMessage(bob, 'msg 2');
        await waitForMessage(b, 'msg 2');

        await ctxA.close();
        await ctxB.close();
        await ctxBob.close();
    });
});
