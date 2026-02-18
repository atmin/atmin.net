import { expect, type Page } from '@playwright/test';

const MSG_SELECTOR = '.rounded.bg-white.p-3.shadow-sm';

/**
 * Register a new user via the UI and return their invite handle.
 * Assumes the page is not logged in.
 */
export async function registerUser(page: Page): Promise<string> {
    const { handle } = await registerUserWithMnemonic(page);
    return handle;
}

/**
 * Register a new user via the UI and return both their invite handle
 * and recovery mnemonic (needed for multi-device login).
 */
export async function registerUserWithMnemonic(
    page: Page,
): Promise<{ handle: string; mnemonic: string }> {
    await page.goto('/register');

    // Wait for mnemonic to be generated
    await page.waitForSelector('.font-mono');

    // Capture the mnemonic before completing registration
    const mnemonic = await page.locator('.font-mono').textContent();
    if (!mnemonic) throw new Error('Could not extract mnemonic');

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

    return { handle: handle.trim(), mnemonic: mnemonic.trim() };
}

/**
 * Log in on a second device using an existing user's invite handle
 * and recovery mnemonic. Assumes the page is not logged in.
 */
export async function loginUser(
    page: Page,
    handle: string,
    mnemonic: string,
): Promise<void> {
    await page.goto('/login');

    await page.fill('#invite-handle', handle);
    await page.fill('#mnemonic', mnemonic);
    await page.getByRole('button', { name: 'Sign In' }).click();

    // Wait for redirect to home page
    await page.waitForSelector('text=Your invite handle', {
        timeout: 15_000,
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
    await page.waitForSelector('text=Your invite handle', {
        timeout: 15_000,
    });
    await openChat(page, handle);
}

/**
 * Return the number of message bubbles currently visible.
 */
export async function getMessageCount(page: Page): Promise<number> {
    return page.locator(MSG_SELECTOR).count();
}

/**
 * Trigger server-side compaction of a user's inbox via the API.
 * Reads the auth token from localStorage and compacts all live messages.
 */
export async function compactInbox(
    page: Page,
    userId: string,
): Promise<{ archived: number; archive_key: string }> {
    return page.evaluate(async (uid: string) => {
        const token = localStorage.getItem('atmin:token');
        if (!token) throw new Error('No auth token in localStorage');

        // List all live messages to find the last key
        const listRes = await fetch(
            `/v1/store/list?${new URLSearchParams({ prefix: `inbox/${uid}/live/` })}`,
            { headers: { Authorization: `Bearer ${token}` } },
        );
        if (!listRes.ok) throw new Error(`List failed: ${listRes.status}`);
        const { keys } = (await listRes.json()) as { keys: string[] };
        if (keys.length === 0) throw new Error('No live messages to compact');

        // Extract the last msg_id from the key path
        const prefix = `inbox/${uid}/live/`;
        const lastMsgId = keys[keys.length - 1].slice(prefix.length);

        // Call compact
        const compactRes = await fetch('/v1/store/compact', {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ prefix, up_to: lastMsgId }),
        });
        if (!compactRes.ok)
            throw new Error(`Compact failed: ${compactRes.status}`);
        return compactRes.json() as Promise<{
            archived: number;
            archive_key: string;
        }>;
    }, userId);
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
