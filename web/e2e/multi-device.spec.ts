import { expect, test } from '@playwright/test';
import {
    getMessageCount,
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    resyncChat,
    sendMessage,
    waitForMessage,
} from './helpers';

test.describe('Multi-Device', () => {
    test('Second device sees history and all devices stay in sync', async ({
        browser,
    }) => {
        const laptopCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const laptop = await laptopCtx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Alice registers on laptop, Bob registers ──────────
        const { handle: aliceHandle, password } =
            await registerUserWithPassword(laptop);
        const bobHandle = await registerUser(bob);

        // ── 2. Bob sends "Hey Alice" ─────────────────────────────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Hey Alice');

        // ── 3. Alice (laptop) sees it and replies ────────────────
        await openChat(laptop, bobHandle);
        await waitForMessage(laptop, 'Hey Alice');
        await sendMessage(laptop, 'Hey Bob');

        // Bob sees the reply
        await waitForMessage(bob, 'Hey Bob');

        // ── 4. Alice adds her phone (second device) ─────────────
        const phoneCtx = await browser.newContext();
        const phone = await phoneCtx.newPage();
        await loginUser(phone, aliceHandle, password);

        // ── 5. Phone opens chat and sees full history ────────────
        await openChat(phone, bobHandle);
        await waitForMessage(phone, 'Hey Alice');
        await waitForMessage(phone, 'Hey Bob');
        expect(await getMessageCount(phone)).toBe(2);

        // ── 6. Alice sends from phone ────────────────────────────
        await sendMessage(phone, 'Sent from my phone');

        // ── 7. Bob re-syncs and sees the phone's message ─────────
        await resyncChat(bob, aliceHandle);
        await waitForMessage(bob, 'Sent from my phone');

        // ── 8. Bob replies ───────────────────────────────────────
        await sendMessage(bob, 'Got it!');

        // ── 9. Phone sees Bob's reply (cross-user SSE) ───────────
        await waitForMessage(phone, 'Got it!');

        // ── 10. Laptop re-syncs and sees all messages ────────────
        await resyncChat(laptop, bobHandle);
        await waitForMessage(laptop, 'Sent from my phone');
        await waitForMessage(laptop, 'Got it!');

        // Final counts: Hey Alice, Hey Bob, Sent from my phone, Got it!
        expect(await getMessageCount(laptop)).toBe(4);
        expect(await getMessageCount(phone)).toBe(4);
        expect(await getMessageCount(bob)).toBe(4);

        // ── Cleanup ──────────────────────────────────────────────
        await laptopCtx.close();
        await phoneCtx.close();
        await bobCtx.close();
    });
});
