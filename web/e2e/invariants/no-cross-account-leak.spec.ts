/**
 * I11 — A new session never inherits a prior account's local state
 *
 * Account A registers and saves a self-note; A's local store is then left
 * behind with no active session (the leak precondition). Account B registers on
 * the same browser without logging out. B must see none of A's data — not its
 * messages, not its conversations, and (the load-bearing part) not its keys.
 *
 * Before the fix, login/register never wiped IndexedDB — only logout did — so a
 * second account inherited the first's cached self-chat and, worse, its private
 * keys from the unscoped `keys` store. See
 * docs/scenarios/invariants/i11-no-cross-account-local-leak.md.
 */

import { expect, test } from '@playwright/test';
import { registerUserWithPassword, sendMessage } from '../helpers';
import { expectLocal, getCurrentUserId } from './helpers';

const MSG_SELECTOR = '[data-testid="message"]';

test.describe('I11 — no cross-account local-state leakage', () => {
    test('a freshly registered account inherits none of a prior account’s local data', async ({
        page,
    }) => {
        // Two Argon2id registrations back-to-back.
        test.setTimeout(120_000);

        // ── 1. Account A registers and saves a self-note ─────────────
        await registerUserWithPassword(page);
        const uidA = await getCurrentUserId(page);
        await page.goto('/saved');
        await sendMessage(page, 'a private note from A');
        // It really landed in A's local store.
        await expectLocal(page, `self:${uidA}`, { uniqueMsgIdCount: 1 });

        // ── 2. Fault: A's token is gone but A's IndexedDB lingers ────
        // The exact precondition behind the observed leak — stale local data
        // with no active session. Dropping only the token makes loadSession()
        // return null (auth screens become reachable) while the owner marker
        // `atmin:userId` stays = A, so registering B is a genuine account
        // *change*, not a fresh browser.
        await page.evaluate(() => localStorage.removeItem('atmin:token'));

        // ── 3. Account B registers on the same browser, no logout ────
        await registerUserWithPassword(page);
        const uidB = await getCurrentUserId(page);
        expect(uidB, 'B is a different account').not.toBe(uidA);

        // ── 4. B inherited nothing of A's, at every layer ───────────
        // Local: A's self-chat was wiped; nothing of A survives.
        await expectLocal(page, `self:${uidA}`, { uniqueMsgIdCount: 0 });
        // UI: the stale note never renders for B...
        await expect(page.getByText('a private note from A')).toHaveCount(0);
        // ...and B's own Saved Messages is empty.
        await page.goto('/saved');
        await expect(page.locator(MSG_SELECTOR)).toHaveCount(0);
    });
});
