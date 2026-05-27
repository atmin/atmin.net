import { expect, test } from '@playwright/test';
import {
    getMessageCount,
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    sendMessage,
    waitForMessage,
} from './helpers';

test.describe('Key backup restore', () => {
    test('New device login with password decrypts historical messages', async ({
        browser,
    }) => {
        const device1Ctx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const device1 = await device1Ctx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Alice registers on device 1, Bob registers ────────
        const { handle: aliceHandle, password } =
            await registerUserWithPassword(device1);
        const bobHandle = await registerUser(bob);

        // ── 2. Bob sends Alice a message ──────────────────────────
        // Bob's key share arrives in Alice's inbox and is backed up
        // when Alice processes it on device 1.
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Message from Bob');

        // ── 3. Alice (device 1) receives and replies ──────────────
        // Processing the key share triggers backupSessionKey for
        // Bob's inbound session. Alice's outbound session was already
        // backed up at session-manager creation time.
        await openChat(device1, bobHandle);
        await waitForMessage(device1, 'Message from Bob');
        await sendMessage(device1, 'Reply from Alice');

        // Bob confirms delivery
        await waitForMessage(bob, 'Reply from Alice');

        // ── 4. Alice logs in on a fresh device with only her password
        const device2Ctx = await browser.newContext();
        const device2 = await device2Ctx.newPage();
        await loginUser(device2, aliceHandle, password);

        // ── 5. Device 2 opens the chat ────────────────────────────
        // restoreSessionKeys runs before setSessionManager, so inbound
        // sessions are available before the first fetchMessages call.
        await openChat(device2, bobHandle);

        // Both messages must decrypt — Bob's via the restored inbound
        // session key, Alice's own reply via her backed-up outbound key.
        await waitForMessage(device2, 'Message from Bob');
        await waitForMessage(device2, 'Reply from Alice');
        expect(await getMessageCount(device2)).toBe(2);

        // ── Cleanup ───────────────────────────────────────────────
        await device1Ctx.close();
        await device2Ctx.close();
        await bobCtx.close();
    });
});
