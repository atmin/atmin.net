import { expect, test } from '@playwright/test';
import {
    openChat,
    registerUser,
    sendMessage,
    waitForMessage,
} from './helpers';

test.describe('Profile Management', () => {
    test('Alice sets display name, Bob sees it after resolving her handle', async ({
        browser,
    }) => {
        const aliceContext = await browser.newContext();
        const bobContext = await browser.newContext();
        const alice = await aliceContext.newPage();
        const bob = await bobContext.newPage();

        // ── 1. Alice registers ───────────────────────────────────
        const aliceHandle = await registerUser(alice);

        // ── 2. Alice navigates to settings and sets display name ─
        await alice.click('text=Settings');
        await alice.waitForURL('**/settings');
        await alice.fill('#display-name', 'Alice Wonderland');
        await alice.getByRole('button', { name: 'Save' }).click();
        await alice.waitForSelector('text=Saved', { timeout: 5_000 });

        // ── 3. Bob registers ─────────────────────────────────────
        await registerUser(bob);

        // ── 4. Bob opens chat with Alice and sends a message ─────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Hey Alice');

        // ── 5. Bob goes to chat list — sees "Alice Wonderland" ───
        await bob.goto('/');
        await bob.waitForSelector('text=Your handle', {
            timeout: 15_000,
        });
        await expect(
            bob.locator('text=Alice Wonderland'),
        ).toBeVisible({ timeout: 15_000 });

        // ── 6. Bob clicks the conversation — chat loads via handle ─
        await bob.click('text=Alice Wonderland');
        await waitForMessage(bob, 'Hey Alice');

        // ── Cleanup ──────────────────────────────────────────────
        await aliceContext.close();
        await bobContext.close();
    });

    test('Bob sees updated display name after Alice changes it', async ({
        browser,
    }) => {
        const aliceContext = await browser.newContext();
        const bobContext = await browser.newContext();
        const alice = await aliceContext.newPage();
        const bob = await bobContext.newPage();

        // ── 1. Both register ─────────────────────────────────────
        const aliceHandle = await registerUser(alice);
        await registerUser(bob);

        // ── 2. Alice sets initial display name ───────────────────
        await alice.click('text=Settings');
        await alice.waitForURL('**/settings');
        await alice.fill('#display-name', 'Alice');
        await alice.getByRole('button', { name: 'Save' }).click();
        await alice.waitForSelector('text=Saved', { timeout: 5_000 });

        // ── 3. Bob chats with Alice — caches "Alice" ─────────────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'Hey');
        await bob.goto('/');
        await bob.waitForSelector('text=Your handle', {
            timeout: 15_000,
        });
        await expect(bob.locator('text=Alice')).toBeVisible({
            timeout: 15_000,
        });

        // ── 4. Alice changes her display name ────────────────────
        await alice.goto('/settings');
        await alice.fill('#display-name', 'Alice Wonderland');
        await alice.getByRole('button', { name: 'Save' }).click();
        await alice.waitForSelector('text=Saved', { timeout: 5_000 });

        // ── 5. Bob reloads chat list — sees updated name ─────────
        await bob.goto('/');
        await bob.waitForSelector('text=Your handle', {
            timeout: 15_000,
        });
        await expect(
            bob.locator('text=Alice Wonderland'),
        ).toBeVisible({ timeout: 15_000 });

        // ── 6. Bob clicks the conversation — chat loads via handle ─
        await bob.click('text=Alice Wonderland');
        await waitForMessage(bob, 'Hey');

        // ── Cleanup ──────────────────────────────────────────────
        await aliceContext.close();
        await bobContext.close();
    });
});
