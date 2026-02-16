import { expect, test } from '@playwright/test';
import {
    getMessageCount,
    getMegolmState,
    openChat,
    registerUser,
    sendMessage,
    waitForMessage,
} from './helpers';

test.describe('Session Rotation', () => {
    test('Alice decrypts messages across rotation boundary (rotation on restart)', async ({
        browser,
    }) => {
        const aliceContext = await browser.newContext();
        const bobContext = await browser.newContext();
        const alice = await aliceContext.newPage();
        const bob = await bobContext.newPage();

        // ── 1. Register both users ─────────────────────────────────
        const aliceHandle = await registerUser(alice);
        const bobHandle = await registerUser(bob);

        // ── 2. Bob opens chat with Alice, sends on session 1 ──────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Before restart');

        // Snapshot IndexedDB: 1 outbound, 1 self-inbound
        const before = await getMegolmState(bob);
        expect(before.outboundSessionId).toBeTruthy();
        expect(before.inboundCount).toBe(1);

        // ── 3. Bob reloads (rotation-on-start → new session) ───────
        await bob.goto('/');
        await bob.waitForSelector('text=Your invite handle', {
            timeout: 15_000,
        });

        // ── 4. Bob opens chat again, sends on session 2 ───────────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'After restart');

        // Snapshot IndexedDB: new outbound, 2 inbounds (old + new self-inbound)
        const after = await getMegolmState(bob);
        expect(after.outboundSessionId).toBeTruthy();
        expect(after.outboundSessionId).not.toBe(before.outboundSessionId);
        expect(after.inboundCount).toBe(2);

        // ── 5. Alice opens chat and sees both messages ─────────────
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'Before restart');
        await waitForMessage(alice, 'After restart');

        expect(await getMessageCount(alice)).toBe(2);

        // ── Cleanup ────────────────────────────────────────────────
        await aliceContext.close();
        await bobContext.close();
    });
});
