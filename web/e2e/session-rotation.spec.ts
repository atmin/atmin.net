import { expect, test } from '@playwright/test';
import {
    compactInbox,
    getMessageCount,
    getMegolmState,
    loginUser,
    openChat,
    registerUser,
    registerUserWithMnemonic,
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

    test('Compaction archives are readable by new device', async ({
        browser,
    }) => {
        const aliceContext = await browser.newContext();
        const bobContext = await browser.newContext();
        const alice = await aliceContext.newPage();
        const bob = await bobContext.newPage();

        // ── 1. Register both users (Alice with mnemonic for multi-device) ──
        const { handle: aliceHandle, mnemonic: aliceMnemonic } =
            await registerUserWithMnemonic(alice);
        const bobHandle = await registerUser(bob);

        // Get Alice's userId from localStorage (prefixed with 'atmin:')
        const aliceUserId = await alice.evaluate(() =>
            localStorage.getItem('atmin:userId'),
        );
        expect(aliceUserId).toBeTruthy();

        // ── 2. Bob sends a message to Alice ──────────────────────────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Before compaction');

        // ── 3. Alice opens chat, sees message, replies ───────────────
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'Before compaction');
        await sendMessage(alice, 'Got it');
        expect(await getMessageCount(alice)).toBe(2);

        // ── 4. Compact Alice's inbox (moves live → CBOR archive) ─────
        const compactResult = await compactInbox(alice, aliceUserId!);
        expect(compactResult.archived).toBeGreaterThan(0);
        expect(compactResult.archive_key).toContain('archive/');

        // ── 5. Alice's new device logs in with mnemonic ──────────────
        const phoneContext = await browser.newContext();
        const phone = await phoneContext.newPage();
        await loginUser(phone, aliceHandle, aliceMnemonic);

        // ── 6. New device opens chat → reads archives ────────────────
        await openChat(phone, bobHandle);
        await waitForMessage(phone, 'Before compaction');
        await waitForMessage(phone, 'Got it');
        expect(await getMessageCount(phone)).toBe(2);

        // ── Cleanup ────────────────────────────────────────────────
        await phoneContext.close();
        await aliceContext.close();
        await bobContext.close();
    });
});
