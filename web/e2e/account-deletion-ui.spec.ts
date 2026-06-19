import { expect, test } from '@playwright/test';
import {
    loginUser,
    registerUserWithPassword,
    tickKonstaCheckbox,
} from './helpers';

// Scenario: docs/scenarios/account-deletion.md (client-side flow).
test.describe('Account deletion (Settings → Danger zone)', () => {
    async function expandDangerZone(page: import('@playwright/test').Page) {
        await page.goto('/settings');
        await page.getByTestId('delete-account-trigger').click();
    }

    test('wrong password fails locally — no DELETE call', async ({ page }) => {
        await registerUserWithPassword(page);
        await expandDangerZone(page);

        let deleteCalled = false;
        page.on('request', (req) => {
            if (
                new URL(req.url()).pathname === '/v1/profile' &&
                req.method() === 'DELETE'
            ) {
                deleteCalled = true;
            }
        });

        await page.locator('#delete-password').fill('definitely-wrong');
        // Handle confirm + ack so only the password is at fault.
        await page
            .getByTestId('delete-account-handle-confirm')
            .fill(
                await page.evaluate(
                    () => localStorage.getItem('atmin:handle') ?? '',
                ),
            );
        await tickKonstaCheckbox(page, 'delete-account-ack');
        await page.getByTestId('delete-account-submit').click();

        await expect(page.getByText('Password is incorrect.')).toBeVisible({
            timeout: 30_000,
        });
        // Form is still open; the destructive endpoint was never hit.
        await expect(page.getByTestId('delete-account-submit')).toBeVisible();
        expect(deleteCalled).toBe(false);
    });

    test('submit is gated on a matching typed handle', async ({ page }) => {
        const { handle } = await registerUserWithPassword(page);
        await expandDangerZone(page);

        await page
            .locator('#delete-password')
            .fill('correct-horse-battery-staple-7');
        await tickKonstaCheckbox(page, 'delete-account-ack');

        // Wrong handle → disabled.
        await page
            .getByTestId('delete-account-handle-confirm')
            .fill('not-the-handle');
        await expect(page.getByTestId('delete-account-submit')).toBeDisabled();

        // Correct handle → enabled.
        await page.getByTestId('delete-account-handle-confirm').fill(handle);
        await expect(page.getByTestId('delete-account-submit')).toBeEnabled();
    });

    test('full delete: lands on confirmation, wipes IDB, frees handle to cooldown', async ({
        page,
        browser,
    }) => {
        test.slow(); // multiple Argon2id derivations + multi-context
        const { handle, password } = await registerUserWithPassword(page);

        // A second device, signed in before the delete, to prove propagation.
        const otherCtx = await browser.newContext();
        const other = await otherCtx.newPage();
        await loginUser(other, handle, password);

        await expandDangerZone(page);
        await page.locator('#delete-password').fill(password);
        await page.getByTestId('delete-account-handle-confirm').fill(handle);
        await tickKonstaCheckbox(page, 'delete-account-ack');
        await page.getByTestId('delete-account-submit').click();

        // Lands on Landing with the one-shot confirmation.
        await expect(page.getByTestId('account-deleted-notice')).toBeVisible({
            timeout: 30_000,
        });

        // Local IDB is gone.
        const dbs = await page.evaluate(async () => {
            if (!indexedDB.databases) return [];
            return (await indexedDB.databases()).map((d) => d.name);
        });
        expect(dbs).not.toContain('atmin');

        // The confirmation is one-shot — a reload of / shows nothing.
        await page.goto('/');
        await expect(page.getByTestId('account-deleted-notice')).toHaveCount(0);

        // The second device is kicked out on its next request (deleted device
        // file → 403 device_revoked, prompt because the delete evicted the
        // device cache). Visit a protected route so the session-null redirect
        // resolves to /login (a null session at "/" renders Landing).
        await other.goto('/saved');
        await other.waitForURL('**/login', { timeout: 30_000 });

        // Resolve returns 410 (released), not 404 (tombstone path).
        const status = await other.evaluate(async (h) => {
            const res = await fetch(`/v1/resolve/${h}`);
            return res.status;
        }, handle);
        expect(status).toBe(410);

        // Registering the freed handle during cooldown is blocked.
        await other.goto('/register');
        await other.fill('#handle', handle);
        await expect(other.getByTestId('handle-availability')).not.toHaveText(
            /Available/,
            { timeout: 10_000 },
        );

        await otherCtx.close();
    });
});
