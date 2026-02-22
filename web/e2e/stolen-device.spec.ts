import { expect, test } from '@playwright/test';
import {
    loginUser,
    openChat,
    registerUser,
    registerUserWithMnemonic,
    resyncChat,
    sendMessage,
    waitForMessage,
} from './helpers';

test.describe('Stolen Device', () => {
    test('Alice revokes stolen phone; phone self-wipes, laptop keeps working', async ({
        browser,
    }) => {
        const laptopCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const laptop = await laptopCtx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Alice registers on laptop (with mnemonic), Bob registers ──
        const { handle: aliceHandle, mnemonic } =
            await registerUserWithMnemonic(laptop);
        const bobHandle = await registerUser(bob);

        // ── 2. Alice adds her phone (second device) ─────────────────────
        const phoneCtx = await browser.newContext();
        const phone = await phoneCtx.newPage();
        await loginUser(phone, aliceHandle, mnemonic);

        // ── 3. Bob sends "Hey Alice", phone syncs and sees it ────────────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Hey Alice');

        await openChat(phone, bobHandle);
        await waitForMessage(phone, 'Hey Alice');

        // ── 4. Alice opens Settings on laptop, sees two devices listed ───
        await laptop.goto('/settings');
        await laptop.waitForSelector('[data-testid="device-list"]', {
            timeout: 15_000,
        });
        const deviceItems = laptop.locator('[data-testid="device-item"]');
        expect(await deviceItems.count()).toBe(2);

        // Verify "this device" indicator is shown
        await expect(laptop.locator('text=(this device)')).toBeVisible();

        // ── 5. Alice clicks "Revoke" on the phone, enters mnemonic, confirms ──
        // Find the device item that does NOT have "(this device)" and click its Revoke button
        const otherDevice = deviceItems.filter({
            hasNot: laptop.locator('text=(this device)'),
        });
        await otherDevice
            .locator('[data-testid="revoke-button"]')
            .click();

        // Enter mnemonic and confirm
        await laptop.fill('[data-testid="mnemonic-input"]', mnemonic);
        await laptop.click('[data-testid="confirm-revoke"]');

        // ── 6. Device list now shows only the laptop ─────────────────────
        await expect(deviceItems).toHaveCount(1, { timeout: 15_000 });
        await expect(laptop.locator('text=(this device)')).toBeVisible();

        // ── 7. Phone triggers a sync — sees welcome/landing screen ───────
        // Navigate phone home, then open a chat to force fetchMessages (triggers 403)
        await phone.goto('/');
        await phone.waitForSelector('text=Your handle', { timeout: 15_000 });
        // Opening a chat triggers useChat → fetchMessages → storeList → 403 → self-wipe
        await phone.fill('input[placeholder="Enter a handle..."]', bobHandle);
        await phone.getByRole('button', { name: 'Chat' }).click();
        // The self-wipe redirects to /login which shows the "Sign In" button
        await expect(
            phone.getByRole('button', { name: 'Sign In' }),
        ).toBeVisible({ timeout: 30_000 });

        // ── 8. Phone's IndexedDB is gone ─────────────────────────────────
        // deleteDatabase is async; poll until it's gone
        await expect(async () => {
            const dbExists = await phone.evaluate(async () => {
                const dbs = await indexedDB.databases();
                return dbs.some((db) => db.name === 'atmin');
            });
            expect(dbExists).toBe(false);
        }).toPass({ timeout: 5_000 });

        // ── 9. Bob sends "Post-revocation msg", laptop sees it, phone does not ──
        await resyncChat(bob, aliceHandle);
        await sendMessage(bob, 'Post-revocation msg');

        // Laptop sees it
        await resyncChat(laptop, bobHandle);
        await waitForMessage(laptop, 'Post-revocation msg');

        // Phone should still be on the login page, not logged in
        await expect(
            phone.getByRole('button', { name: 'Sign In' }),
        ).toBeVisible();

        // ── Cleanup ──────────────────────────────────────────────────────
        await laptopCtx.close();
        await phoneCtx.close();
        await bobCtx.close();
    });
});
