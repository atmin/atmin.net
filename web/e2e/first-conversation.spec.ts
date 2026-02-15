import { expect, test } from '@playwright/test';
import { registerUser } from './helpers';

const MSG_SELECTOR = '.rounded.bg-white.p-3.shadow-sm';

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
        await bob.fill('input[placeholder="Enter a handle..."]', aliceHandle);
        await bob.getByRole('button', { name: 'Chat' }).click();
        await bob.waitForURL(`**/${aliceHandle}`);

        await bob.getByPlaceholder('Type a message...').fill('Hey Alice');
        await bob.getByRole('button', { name: 'Send' }).click();

        // Wait for message to appear in Bob's own chat (self-copy)
        await expect(
            bob.locator(MSG_SELECTOR).filter({ hasText: 'Hey Alice' }),
        ).toBeVisible({ timeout: 15_000 });

        // ── 4. Alice opens chat with Bob and sees "Hey Alice" ────
        await alice.fill(
            'input[placeholder="Enter a handle..."]',
            bobHandle,
        );
        await alice.getByRole('button', { name: 'Chat' }).click();
        await alice.waitForURL(`**/${bobHandle}`);

        await expect(
            alice.locator(MSG_SELECTOR).filter({ hasText: 'Hey Alice' }),
        ).toBeVisible({ timeout: 15_000 });

        // ── 5. Alice replies "Hey Bob" ───────────────────────────
        await alice.getByPlaceholder('Type a message...').fill('Hey Bob');
        await alice.getByRole('button', { name: 'Send' }).click();

        await expect(
            alice.locator(MSG_SELECTOR).filter({ hasText: 'Hey Bob' }),
        ).toBeVisible({ timeout: 15_000 });

        // ── 6. Bob sees "Hey Bob" via SSE ────────────────────────
        await expect(
            bob.locator(MSG_SELECTOR).filter({ hasText: 'Hey Bob' }),
        ).toBeVisible({ timeout: 15_000 });

        // ── Verify both see 2 messages ───────────────────────────
        await expect(bob.locator(MSG_SELECTOR)).toHaveCount(2);
        await expect(alice.locator(MSG_SELECTOR)).toHaveCount(2);

        // ── Cleanup ──────────────────────────────────────────────
        await aliceContext.close();
        await bobContext.close();
    });
});
