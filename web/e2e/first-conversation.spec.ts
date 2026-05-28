import { expect, test } from '@playwright/test';
import {
    getMessageCount,
    openChat,
    registerUser,
    resyncChat,
    sendMessage,
    waitForMessage,
} from './helpers';

test.describe('First Conversation', () => {
    test('Alice and Bob register, exchange encrypted messages in real time', async ({
        browser,
    }) => {
        const aliceContext = await browser.newContext();
        const bobContext = await browser.newContext();
        const alice = await aliceContext.newPage();
        const bob = await bobContext.newPage();

        // ── 1. Alice registers ───────────────────────────────────
        const aliceHandle = await registerUser(alice);

        // ── 2. Bob registers ─────────────────────────────────────
        const bobHandle = await registerUser(bob);
        expect(bobHandle).not.toBe(aliceHandle);

        // ── 3. Bob opens chat with Alice and sends "Hey Alice" ───
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Hey Alice');

        // ── 4. Alice opens chat with Bob and sees "Hey Alice" ────
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'Hey Alice');

        // ── 5. Alice replies "Hey Bob" ───────────────────────────
        await sendMessage(alice, 'Hey Bob');

        // ── 6. Bob sees "Hey Bob" via SSE ────────────────────────
        await waitForMessage(bob, 'Hey Bob');

        // ── Verify both see 2 messages ───────────────────────────
        expect(await getMessageCount(alice)).toBe(2);
        expect(await getMessageCount(bob)).toBe(2);

        // ── Newest message is visible; no jump indicator on a fresh chat ──
        await expect(bob.getByText('Hey Bob')).toBeInViewport();
        await expect(bob.getByTestId('jump-to-bottom')).toBeHidden();
        await expect(alice.getByText('Hey Bob')).toBeInViewport();
        await expect(alice.getByTestId('jump-to-bottom')).toBeHidden();

        // ── Cleanup ──────────────────────────────────────────────
        await aliceContext.close();
        await bobContext.close();
    });

    test('long chat opens scrolled to the newest message', async ({
        browser,
    }) => {
        // Only Bob is observed. Alice exists solely so Bob has a handle
        // to address — her page is never opened, which keeps incoming
        // SSE traffic off the observed client and the test focused on
        // the sender-side scroll behaviour.
        const aliceContext = await browser.newContext();
        const bobContext = await browser.newContext();
        const alice = await aliceContext.newPage();
        const bob = await bobContext.newPage();

        const aliceHandle = await registerUser(alice);
        await registerUser(bob);

        await openChat(bob, aliceHandle);

        // Build enough history that the messages area must scroll.
        const TOTAL = 20;
        for (let i = 1; i <= TOTAL; i++) {
            await sendMessage(bob, `message ${i}`);
        }

        // Re-open the chat from the chats list so we exercise the
        // "first paint with messages already loaded" path.
        await resyncChat(bob, aliceHandle);
        await waitForMessage(bob, `message ${TOTAL}`);

        await expect(
            bob.getByText(`message ${TOTAL}`, { exact: true }),
        ).toBeInViewport();
        await expect(bob.getByTestId('jump-to-bottom')).toBeHidden();
        // The oldest message must be scrolled out of view; otherwise the
        // viewport is tall enough that scrolling wasn't actually required
        // and this test isn't proving anything. `exact` avoids matching
        // "message 10".."message 19" alongside "message 1".
        await expect(
            bob.getByText('message 1', { exact: true }),
        ).not.toBeInViewport();

        await aliceContext.close();
        await bobContext.close();
    });
});
