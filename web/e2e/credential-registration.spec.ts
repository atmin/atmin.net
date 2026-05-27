import { expect, test } from '@playwright/test';
import {
    getMessageCount,
    openChat,
    registerUserWithPassword,
    sendMessage,
    waitForMessage,
} from './helpers';

test.describe('Credential registration (password)', () => {
    test('registration page asks for a password, not a recovery phrase', async ({
        page,
    }) => {
        await page.goto('/register');

        // Password + confirm fields are present...
        await expect(page.locator('#password')).toBeVisible();
        await expect(page.locator('#confirm')).toBeVisible();

        // ...and the legacy recovery-phrase UI is gone.
        await expect(page.getByText(/recovery phrase/i)).toHaveCount(0);
        await expect(page.getByText(/12 words/i)).toHaveCount(0);
    });

    test('Alice and Bob register with passwords and exchange encrypted messages', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Both register with a password (Argon2id-derived keys) ──
        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const { handle: bobHandle } = await registerUserWithPassword(bob);
        expect(aliceHandle).not.toBe(bobHandle);

        // ── 2. Bob → Alice ────────────────────────────────────────────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Hey Alice');

        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'Hey Alice');

        // ── 3. Alice → Bob ────────────────────────────────────────────
        await sendMessage(alice, 'Hey Bob');
        await waitForMessage(bob, 'Hey Bob');

        // Both sides decrypted both messages.
        expect(await getMessageCount(alice)).toBe(2);
        expect(await getMessageCount(bob)).toBe(2);

        await aliceCtx.close();
        await bobCtx.close();
    });
});
