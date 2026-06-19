import { expect, test } from '@playwright/test';
import {
    getMegolmState,
    getMessageCount,
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    sendMessage,
    waitForChatList,
    waitForMessage,
} from './helpers';

test.describe('Session Rotation', () => {
    // Argon2id-heavy (register + new-device restore/decrypt): triple the
    // default timeout so machine load doesn't flake it.
    test.beforeEach(() => test.slow());

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
        await waitForChatList(bob, 15_000);

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

        // ── 1. Register both users (Alice keeps her password for multi-device) ──
        const { handle: aliceHandle, password: alicePassword } =
            await registerUserWithPassword(alice);
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

        // ── 4. Verify sync compacted Alice's inbox into an archive ─────
        const archiveKeys = await alice.evaluate(async (uid) => {
            const token = localStorage.getItem('atmin:token');
            const res = await fetch(
                `/v1/store/list?${new URLSearchParams({ prefix: `inbox/${uid}/archive/` })}`,
                { headers: { Authorization: `Bearer ${token}` } },
            );
            const { keys } = await res.json();
            return keys;
        }, aliceUserId!);
        expect(archiveKeys.length).toBeGreaterThan(0);

        // ── 5. Alice's new device logs in with her password ──────────
        const phoneContext = await browser.newContext();
        const phone = await phoneContext.newPage();
        await loginUser(phone, aliceHandle, alicePassword);

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
