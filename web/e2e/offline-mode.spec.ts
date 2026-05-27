import { expect, test } from '@playwright/test';
import {
    openChat,
    registerUser,
    registerUserWithPassword,
    sendMessage,
    waitForMessage,
} from './helpers';

test.describe('Offline mode', () => {
    test('shows cached messages offline, blocks send, syncs on reconnect', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // Register both. Alice captures her password so she could log back
        // in after a reload if needed.
        const { handle: aliceHandle } =
            await registerUserWithPassword(alice);
        const bobHandle = await registerUser(bob);

        // Bob sends a message while both are online; Alice receives.
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Message before offline');

        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'Message before offline');

        // ── Alice goes offline ─────────────────────────────────
        await aliceCtx.setOffline(true);
        // Reload preserves the URL (/<bobHandle>) so Alice stays on the
        // chat page. This is the scenario under test: cached messages must
        // render from IndexedDB without a working network.
        await alice.reload();

        // Cached message still visible from IndexedDB.
        await waitForMessage(alice, 'Message before offline');

        // Offline indicator is shown.
        await expect(
            alice.locator('[data-testid="offline-indicator"]'),
        ).toBeVisible();

        // Send is blocked: button disabled, placeholder reads "You are offline".
        await expect(
            alice.getByPlaceholder('You are offline'),
        ).toBeVisible();
        await alice
            .getByPlaceholder('You are offline')
            .fill('Offline message');
        await expect(
            alice.getByRole('button', { name: 'Send' }),
        ).toBeDisabled();
        await expect(
            alice.locator('[data-testid="message"]', {
                hasText: 'Offline message',
            }),
        ).toHaveCount(0);

        // ── Bob sends while Alice is offline ───────────────────
        await sendMessage(bob, 'Message while Alice offline');

        // ── Alice comes back online ────────────────────────────
        await aliceCtx.setOffline(false);

        // Indicator disappears.
        await expect(
            alice.locator('[data-testid="offline-indicator"]'),
        ).toBeHidden();

        // Bob's offline message arrives via the auto-reconnected SSE + sync.
        await waitForMessage(alice, 'Message while Alice offline');

        // The blocked "Offline message" was never sent.
        await expect(
            alice.locator('[data-testid="message"]', {
                hasText: 'Offline message',
            }),
        ).toHaveCount(0);

        // Sending works again without a page refresh.
        await sendMessage(alice, 'After reconnect');
        await waitForMessage(bob, 'After reconnect');

        await aliceCtx.close();
        await bobCtx.close();
    });
});
