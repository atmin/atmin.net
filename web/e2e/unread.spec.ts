import { expect, test } from '@playwright/test';
import {
    expectNewDivider,
    expectUnreadBadge,
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    sendMessage,
    waitForChatList,
    waitForMessage,
} from './helpers';

test.describe('Unread messages', () => {
    // Argon2id-heavy (register + second-device login); give load headroom.
    test.beforeEach(() => test.slow());

    test('chats-row badge counts unread, and the "New" divider clears on read', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const aliceHandle = await registerUser(alice);
        const bobHandle = await registerUser(bob);

        // Bob sends two messages while Alice sits on her chat list.
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'first');
        await sendMessage(bob, 'second');

        // Alice syncs (without opening the chat) — the new row shows "2" unread.
        await alice.goto('/');
        await waitForChatList(alice);
        await expectUnreadBadge(alice, bobHandle, 2);

        // Opening the chat shows the "New" divider above the unseen messages.
        await openChat(alice, bobHandle);
        await expectNewDivider(alice, true);
        await waitForMessage(alice, 'first');
        await waitForMessage(alice, 'second');

        // Back on the list, the unread badge is gone — the chat is read.
        await alice.goto('/');
        await waitForChatList(alice);
        await expectUnreadBadge(alice, bobHandle, null);

        // Reopening shows no divider — nothing is unseen anymore.
        await openChat(alice, bobHandle);
        await expectNewDivider(alice, false);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('a read on one device clears the unread on another (no fake "new")', async ({
        browser,
    }) => {
        const laptopCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const laptop = await laptopCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle, password } =
            await registerUserWithPassword(laptop);
        const bobHandle = await registerUser(bob);

        // Bob sends; Alice reads on her laptop.
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'ping one');
        await sendMessage(bob, 'ping two');

        await openChat(laptop, bobHandle);
        await waitForMessage(laptop, 'ping one');
        await waitForMessage(laptop, 'ping two');
        await expectNewDivider(laptop, true);

        // Reload the laptop — its mount-time sync pushes the read marker up to
        // the encrypted blob (the debounced push otherwise lands within seconds).
        await laptop.goto('/');
        await waitForChatList(laptop);

        // Alice adds her phone. Its first sync materializes Bob's messages AND
        // merges the laptop's read marker — so they are already read here.
        const phoneCtx = await browser.newContext();
        const phone = await phoneCtx.newPage();
        await loginUser(phone, aliceHandle, password);
        await waitForChatList(phone);

        // The conversation row appears with NO unread badge — the read synced.
        await expect(
            phone.locator('li').filter({ hasText: bobHandle }),
        ).toBeVisible({ timeout: 30_000 });
        await expectUnreadBadge(phone, bobHandle, null);

        // And opening it shows the full history with no fake "New" divider.
        await openChat(phone, bobHandle);
        await waitForMessage(phone, 'ping one');
        await waitForMessage(phone, 'ping two');
        await expectNewDivider(phone, false);

        await laptopCtx.close();
        await phoneCtx.close();
        await bobCtx.close();
    });
});
