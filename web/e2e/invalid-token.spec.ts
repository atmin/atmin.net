import { expect, test } from '@playwright/test';
import {
    loginUser,
    openChat,
    registerUser,
    registerUserWithMnemonic,
    sendMessage,
    waitForMessage,
} from './helpers';

test.describe('Invalid token (401)', () => {
    test('fetch path — returns to welcome screen and preserves IndexedDB history', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // 1. Register Alice with mnemonic, Bob normally
        const { handle: aliceHandle, mnemonic: aliceMnemonic } =
            await registerUserWithMnemonic(alice);
        const bobHandle = await registerUser(bob);

        // 2. Bob opens chat with Alice, sends 'Hello before 401'
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Hello before 401');

        // 3. Alice opens chat with Bob, waits for message (now in IndexedDB)
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'Hello before 401');

        // 4. Corrupt Alice's token in localStorage
        await alice.evaluate(() =>
            localStorage.setItem('atmin:token', 'invalid'),
        );

        // 5. Reload Alice's page — fetchMessages fires with bad token → 401 → onUnauthorized
        await alice.reload();

        // 6. Alice should be on the welcome screen
        await expect(
            alice.getByRole('button', { name: 'Sign In' }),
        ).toBeVisible({ timeout: 15_000 });

        // 7. IndexedDB still has messages
        const count = await alice.evaluate(
            () =>
                new Promise<number>((resolve) => {
                    const req = indexedDB.open('atmin');
                    req.onsuccess = () => {
                        const db = req.result;
                        const tx = db.transaction('messages', 'readonly');
                        const countReq = tx.objectStore('messages').count();
                        countReq.onsuccess = () => resolve(countReq.result);
                    };
                }),
        );
        expect(count).toBeGreaterThan(0);

        // 8. Alice logs in again
        await loginUser(alice, aliceHandle, aliceMnemonic);

        // 9. Alice opens chat with Bob — 'Hello before 401' visible immediately from IndexedDB
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'Hello before 401');

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('SSE path — 401 on SSE connection triggers re-auth prompt, not offline indicator', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // 1. Register Alice with mnemonic, Bob normally
        await registerUserWithMnemonic(alice);
        const bobHandle = await registerUser(bob);

        // 2. Bob opens chat with Alice's handle (resolved from Alice's registration)
        const aliceHandle = await alice
            .locator('.text-lg')
            .textContent()
            .then((h) => h?.trim() ?? '');

        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Hello');

        // 3. Alice opens chat with Bob, waits for 'Hello' — SSE is now active
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'Hello');

        // 4. Intercept future SSE connections to abort (simulates server rejecting
        //    the token out-of-band, e.g. after a secret rotation)
        await alice.route('**/v1/events*', (route) => route.abort('failed'));

        // 5. Navigate home so useChat unmounts and the current SSE closes cleanly
        await alice.goto('/');
        await alice.waitForSelector('text=Your handle');

        // 6. Intercept the storeList probe to return 401 (token is now invalid on server)
        await alice.route('**/v1/store/list*', (route) =>
            route.fulfill({
                status: 401,
                contentType: 'application/json',
                body: JSON.stringify({
                    error: 'unauthorized',
                    message: 'Token expired',
                }),
            }),
        );

        // 7. Re-navigate to chat: useChat mounts, EventSource is immediately aborted
        //    → onerror fires → navigator.onLine is true → probe storeList → 401
        //    → onUnauthorized → welcome screen
        await alice.goto(`/${bobHandle}`);

        await expect(
            alice.getByRole('button', { name: 'Sign In' }),
        ).toBeVisible({ timeout: 15_000 });

        await aliceCtx.close();
        await bobCtx.close();
    });
});
