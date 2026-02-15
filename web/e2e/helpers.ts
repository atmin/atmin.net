import type { Page } from '@playwright/test';

/**
 * Register a new user via the UI and return their invite handle.
 * Assumes the page is not logged in.
 */
export async function registerUser(page: Page): Promise<string> {
    await page.goto('/register');

    // Wait for mnemonic to be generated
    await page.waitForSelector('.font-mono');

    // Check both required checkboxes
    await page.locator('label', { hasText: 'I understand' }).click();
    await page.locator('label', { hasText: 'I have stored' }).click();

    // Click Register
    await page.getByRole('button', { name: 'Register' }).click();

    // Wait for redirect to home page
    await page.waitForSelector('text=Your invite handle', {
        timeout: 15_000,
    });

    // Extract invite handle
    const handle = await page.locator('.text-lg').textContent();
    if (!handle) throw new Error('Could not extract invite handle');

    return handle.trim();
}
