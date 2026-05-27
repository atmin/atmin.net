import { expect, type Page } from '@playwright/test';

const MSG_SELECTOR = '[data-testid="message"]';

// Shared password for e2e v2 (password-based) registrations. Long enough
// to clear the strength meter; the meter never blocks submit anyway.
export const E2E_PASSWORD = 'correct-horse-battery-staple-7';

/**
 * Register a new user via the UI and return their handle.
 * Assumes the page is not logged in.
 */
export async function registerUser(page: Page): Promise<string> {
    const { handle } = await registerUserWithPassword(page);
    return handle;
}

/**
 * Register a new user via the password UI and return both their handle
 * and the password (needed for multi-device login and revoke re-auth).
 * Argon2id derivation runs client-side, so allow a generous timeout.
 */
export async function registerUserWithPassword(
    page: Page,
    password: string = E2E_PASSWORD,
): Promise<{ handle: string; password: string }> {
    await page.goto('/register');

    await page.fill('#password', password);
    await page.fill('#confirm', password);

    // Acknowledge the no-reset warning, then submit.
    await page.locator('label', { hasText: 'I understand' }).click();
    await page.getByRole('button', { name: 'Register' }).click();

    // Wait for redirect to home page (Argon2id + registration).
    await page.waitForSelector('text=Your handle', {
        timeout: 30_000,
    });

    const handle = await page.locator('.text-lg').textContent();
    if (!handle) throw new Error('Could not extract handle');

    return { handle: handle.trim(), password };
}

/**
 * Log in on a second device using an existing user's handle and
 * credential (password for v2 accounts, or a legacy recovery phrase).
 * Assumes the page is not logged in.
 */
export async function loginUser(
    page: Page,
    handle: string,
    secret: string,
): Promise<void> {
    await page.goto('/login');

    await page.fill('#handle', handle);
    await page.fill('#secret', secret);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Wait for redirect to home page (Argon2id + add-device).
    await page.waitForSelector('text=Your handle', {
        timeout: 30_000,
    });
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
    const sendBtn = page.getByRole('button', { name: 'Send' });
    await page.getByPlaceholder('Type a message...').fill(text);
    await expect(sendBtn).toBeEnabled({ timeout: 15_000 });
    await sendBtn.click();
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
 * Navigate to home and re-open a chat to trigger a fresh sync.
 * Unlike SSE (tested in first-conversation), this guarantees
 * a full fetchMessages pass regardless of event timing.
 */
export async function resyncChat(
    page: Page,
    handle: string,
): Promise<void> {
    await page.goto('/');
    await page.waitForSelector('text=Your handle', {
        timeout: 15_000,
    });
    await openChat(page, handle);
}

/**
 * Attach a file via the chat's hidden file input and wait for send to settle.
 */
export async function sendMedia(page: Page, filePath: string): Promise<void> {
    const before = await page
        .locator('[data-testid="media-attachment"]')
        .count();
    await page.locator('input[type="file"]').setInputFiles(filePath);
    // Wait for our own echoed attachment to render — this is the only
    // reliable signal that encrypt+upload+send all succeeded.
    await expect(
        page.locator('[data-testid="media-attachment"]'),
    ).toHaveCount(before + 1, { timeout: 30_000 });
}

export async function waitForMediaImage(page: Page): Promise<void> {
    await expect(
        page.locator('[data-testid="media-image"]').first(),
    ).toBeVisible({ timeout: 15_000 });
}

export async function waitForMediaDownload(page: Page): Promise<void> {
    await expect(
        page.locator('[data-testid="media-download"]').first(),
    ).toBeVisible({ timeout: 15_000 });
}

/**
 * Return the number of message bubbles currently visible.
 */
export async function getMessageCount(page: Page): Promise<number> {
    return page.locator(MSG_SELECTOR).count();
}

/**
 * Read Megolm session state from IndexedDB.
 */
export async function getMegolmState(page: Page) {
    return page.evaluate(() => {
        return new Promise<{
            outboundSessionId: string | null;
            inboundCount: number;
        }>((resolve, reject) => {
            const req = indexedDB.open('atmin');
            req.onerror = () => reject(req.error);
            req.onsuccess = () => {
                const db = req.result;
                const tx = db.transaction(
                    ['megolm_outbound', 'megolm_inbound'],
                    'readonly',
                );
                const outReq = tx
                    .objectStore('megolm_outbound')
                    .get('current');
                const inReq = tx.objectStore('megolm_inbound').count();
                tx.oncomplete = () =>
                    resolve({
                        outboundSessionId:
                            outReq.result?.sessionId ?? null,
                        inboundCount: inReq.result,
                    });
                tx.onerror = () => reject(tx.error);
            };
        });
    });
}
