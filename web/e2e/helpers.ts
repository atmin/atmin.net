import { expect, type Page } from '@playwright/test';

const MSG_SELECTOR = '[data-testid="message"]';

// Shared password for e2e v2 (password-based) registrations. Long enough
// to clear the strength meter; the meter never blocks submit anyway.
export const E2E_PASSWORD = 'correct-horse-battery-staple-7';

// e2e tests run in parallel; the handle suffix keeps registrations from
// colliding on the per-handle uniqueness check. ULID-shaped lowercase
// alphanumerics, hyphenated, regex-valid.
let handleCounter = 0;
function nextHandle(prefix = 'tester'): string {
    handleCounter += 1;
    const rand = Math.random().toString(36).slice(2, 8);
    return `${prefix}-${rand}-${handleCounter}`;
}

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
    handle: string = nextHandle(),
): Promise<{ handle: string; password: string }> {
    await page.goto('/register');

    // Handle field is server-validated; wait for the availability check to
    // settle before submitting so the button gating goes through ✓ available.
    await page.fill('#handle', handle);
    await expect(page.getByTestId('handle-availability')).toHaveText(
        /Available/,
        { timeout: 10_000 },
    );

    await page.fill('#password', password);
    await page.fill('#confirm', password);

    // setChecked, not click: Radix Checkbox is a <button role="checkbox">.
    const ack = page.getByRole('checkbox', { name: /I understand/i });
    await ack.setChecked(true);
    await expect(ack).toBeChecked({ timeout: 5_000 });
    const register = page.getByRole('button', { name: 'Register' });
    await expect(register).toBeEnabled({ timeout: 5_000 });
    await register.click();

    // Wait for redirect to home page (Argon2id + registration).
    await page.waitForSelector('text=Your handle', {
        timeout: 30_000,
    });

    return { handle, password };
}

/**
 * Log in on a second device using an existing user's handle and
 * password. Assumes the page is not logged in.
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
    await page.waitForURL(`**/@${handle}`);
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
 * Wait until a message containing the given text is visible. The default suits
 * live delivery; pass a larger timeout for fresh-device restore / chain-walk
 * paths, which re-derive (Argon2id) + restore + decrypt before rendering.
 */
export async function waitForMessage(
    page: Page,
    text: string,
    timeout = 15_000,
): Promise<void> {
    await expect(
        page.locator(MSG_SELECTOR).filter({ hasText: text }),
    ).toBeVisible({ timeout });
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
 * Force the global photo-send quality preference (ADR-0022). Optimized is the
 * app default (downscale + re-encode + strip EXIF); tests that assert a
 * byte-exact round-trip or an exact ciphertext length set 'original' so the
 * stored bytes equal the source fixture. Read at send time, so set before
 * sendMedia.
 */
export async function setPhotoQuality(
    page: Page,
    quality: 'optimized' | 'original',
): Promise<void> {
    await page.evaluate((q) => {
        localStorage.setItem('atmin:photo-quality', q);
    }, quality);
}

/**
 * Attach a file via the chat's hidden file input and send it.
 *
 * Picking now STAGES the file in the compose tray (P1d) rather than sending
 * immediately, so we click Send to dispatch and then wait for our own echoed
 * attachment to render — the only reliable signal that encrypt+upload+send all
 * succeeded. Pass `caption` to type a companion message before sending.
 */
export async function sendMedia(
    page: Page,
    filePath: string,
    caption?: string,
): Promise<void> {
    const before = await page
        .locator('[data-testid="media-attachment"]')
        .count();
    await page.locator('input[type="file"]').setInputFiles(filePath);
    await expect(page.getByTestId('compose-tray')).toBeVisible({
        timeout: 15_000,
    });
    if (caption !== undefined) {
        await page.getByTestId('message-input').fill(caption);
    }
    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeEnabled({ timeout: 15_000 });
    await send.click();
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
 * Edit one of the user's own messages via the per-bubble action menu.
 * Matches the bubble by its current text, opens the menu, picks Edit,
 * replaces the body, and saves.
 */
export async function editMessage(
    page: Page,
    oldText: string,
    newText: string,
): Promise<void> {
    const bubble = page
        .locator(MSG_SELECTOR)
        .filter({ hasText: oldText })
        .first();
    await bubble.getByTestId('message-actions-trigger').click();
    await page.getByTestId('message-action-edit').click();
    const input = page.getByTestId('message-edit-input');
    await input.fill(newText);
    await page.getByTestId('message-edit-save').click();
}

/**
 * Delete one of the user's own messages via the per-bubble action menu,
 * confirming the two-step delete prompt.
 */
export async function deleteMessage(page: Page, text: string): Promise<void> {
    const bubble = page
        .locator(MSG_SELECTOR)
        .filter({ hasText: text })
        .first();
    await bubble.getByTestId('message-actions-trigger').click();
    await page.getByTestId('message-action-delete').click();
    await page.getByTestId('message-delete-confirm').click();
}

/**
 * Wait until an edited message with the given text shows its "edited" tag.
 */
export async function waitForEdited(
    page: Page,
    text: string,
    timeout = 15_000,
): Promise<void> {
    const bubble = page.locator(MSG_SELECTOR).filter({ hasText: text }).first();
    await expect(bubble.getByTestId('edited-tag')).toBeVisible({ timeout });
}

/**
 * Wait until a `[deleted]` placeholder bubble is visible.
 */
export async function waitForDeleted(
    page: Page,
    timeout = 15_000,
): Promise<void> {
    await expect(
        page.locator(MSG_SELECTOR).filter({ hasText: '[deleted]' }).first(),
    ).toBeVisible({ timeout });
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
