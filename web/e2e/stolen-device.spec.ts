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

test.describe('Stolen Device', () => {
    test('Alice revokes stolen phone; phone self-wipes, laptop keeps working', async ({
        browser,
    }) => {
        const laptopCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const laptop = await laptopCtx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Alice registers on laptop (keeps password), Bob registers ──
        const { handle: aliceHandle, password } =
            await registerUserWithPassword(laptop);
        const bobHandle = await registerUser(bob);

        // ── 2. Alice adds her phone (second device) ─────────────────────
        const phoneCtx = await browser.newContext();
        const phone = await phoneCtx.newPage();
        const addDeviceResp = phone.waitForResponse(
            (r) =>
                r.url().endsWith('/v1/devices') &&
                r.request().method() === 'POST',
        );
        await loginUser(phone, aliceHandle, password);
        expect((await addDeviceResp).status(), 'phone addDevice').toBe(200);

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
        await expect(deviceItems).toHaveCount(2, { timeout: 15_000 });

        // Verify "this device" indicator is shown
        await expect(laptop.locator('text=(this device)')).toBeVisible();

        // ── 5. Alice clicks "Revoke" on the phone, enters password, confirms ──
        // Find the device item that does NOT have "(this device)" and click its Revoke button
        const otherDevice = deviceItems.filter({
            hasNot: laptop.locator('text=(this device)'),
        });
        await otherDevice
            .locator('[data-testid="revoke-button"]')
            .click();

        // Enter credential (password) and confirm
        await laptop.fill('[data-testid="credential-input"]', password);
        await laptop.click('[data-testid="confirm-revoke"]');

        // ── 6. Device list now shows only the laptop ─────────────────────
        await expect(deviceItems).toHaveCount(1, { timeout: 15_000 });
        await expect(laptop.locator('text=(this device)')).toBeVisible();

        // ── 7. Phone triggers a sync — server returns 403 → self-wipe ────
        // Navigating directly to a chat triggers useChat → fetchMessages → storeList → 403.
        await phone.goto(`/${bobHandle}`);
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
        }).toPass({ timeout: 15_000 });

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
