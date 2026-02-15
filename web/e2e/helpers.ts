import { expect, type Page } from '@playwright/test';

const MSG_SELECTOR = '.rounded.bg-white.p-3.shadow-sm';

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

/**
 * From the chats page, enter a handle and navigate to the chat.
 */
export async function openChat(page: Page, handle: string): Promise<void> {
    await page.fill('input[placeholder="Enter a handle..."]', handle);
    await page.getByRole('button', { name: 'Chat' }).click();
    await page.waitForURL(`**/${handle}`);
}

/**
 * Type a message and send it, then wait for it to appear in the chat.
 */
export async function sendMessage(page: Page, text: string): Promise<void> {
    await page.getByPlaceholder('Type a message...').fill(text);
    await page.getByRole('button', { name: 'Send' }).click();
    await waitForMessage(page, text);
}

/**
 * Wait until a message containing the given text is visible.
 */
export async function waitForMessage(
    page: Page,
    text: string,
): Promise<void> {
    await expect(
        page.locator(MSG_SELECTOR).filter({ hasText: text }),
    ).toBeVisible({ timeout: 15_000 });
}

/**
 * Return the number of message bubbles currently visible.
 */
export async function getMessageCount(page: Page): Promise<number> {
    return page.locator(MSG_SELECTOR).count();
}
