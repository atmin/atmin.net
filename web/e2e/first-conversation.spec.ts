import { expect, test } from '@playwright/test';
import {
    getMessageCount,
    openChat,
    registerUser,
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
        expect(aliceHandle).toMatch(/^[a-z]+-[a-z]+$/);

        // ── 2. Bob registers ─────────────────────────────────────
        const bobHandle = await registerUser(bob);
        expect(bobHandle).toMatch(/^[a-z]+-[a-z]+$/);
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

        // ── Cleanup ──────────────────────────────────────────────
        await aliceContext.close();
        await bobContext.close();
    });
});
