/**
 * I7 — Account deletion races terminate cleanly
 *
 * A DELETE initiated while another device is mid-sync (and a third party is
 * sending) resolves deterministically: the in-flight sync completes against
 * pre-delete state or fails with a recognised auth error — never an uncaught
 * exception or infinite retry. After deletion settles, the other device gets a
 * 401, is logged out, and its IDB is cleared; Remote has no per-user objects
 * but the handle survives as a 30-day cooldown tombstone (resolve 410). Bob's
 * send during the window is either accepted (orphan, swept later) or rejected,
 * never silently lost.
 *
 * See docs/scenarios/invariants/i7-deletion-races.md.
 */

import { expect, test } from '@playwright/test';
import {
    loginUser,
    openChat,
    registerUserWithPassword,
    sendMessage,
    tickKonstaCheckbox,
} from '../helpers';
import { getCurrentUserId, listRemoteKeys, makeS3Client } from './helpers';

test.describe('I7 — account deletion races terminate cleanly', () => {
    test('delete during a concurrent sync + inbound send settles cleanly', async ({
        browser,
    }) => {
        test.setTimeout(150_000); // 3 registrations/logins (Argon2id) + races

        const s3 = makeS3Client();

        const aliceCtx = await browser.newContext();
        const alice2Ctx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const alice2 = await alice2Ctx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle, password } =
            await registerUserWithPassword(alice);
        const { handle: bobHandle } = await registerUserWithPassword(bob);

        // Establish a conversation so Bob can send into Alice's inbox.
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'hello before delete');

        // Alice device 1 reads its uid (for Remote assertions) and opens chat.
        await openChat(alice, bobHandle);
        const aliceUid = await getCurrentUserId(alice);

        // Alice device 2 signs in and is left online + mid-sync (chat open).
        await loginUser(alice2, aliceHandle, password);
        await openChat(alice2, bobHandle);

        // ── Fault window: Bob sends WHILE Alice device 1 deletes. ──
        // Fire both without awaiting in lockstep so they overlap; device 2's
        // SSE-driven sync is in flight against soon-to-be-deleted state.
        const bobSend = sendMessage(bob, 'sent during the window').catch(
            () => 'rejected',
        );

        await alice.goto('/settings');
        await alice.getByTestId('delete-account-trigger').click();
        await alice.locator('#delete-password').fill(password);
        await alice
            .getByTestId('delete-account-handle-confirm')
            .fill(aliceHandle);
        await tickKonstaCheckbox(alice, 'delete-account-ack');
        await alice.getByTestId('delete-account-submit').click();

        // Device 1 lands on the confirmation.
        await expect(alice.getByTestId('account-deleted-notice')).toBeVisible({
            timeout: 30_000,
        });

        // Bob's in-window send resolved one way or the other — never hung.
        await bobSend;

        // ── Assert the settled state across layers. ──

        // Remote: all per-user prefixes gone; handle is a tombstone (present).
        await expect
            .poll(() => listRemoteKeys(s3, `users/${aliceUid}/`), {
                timeout: 20_000,
            })
            .toEqual([]);
        for (const prefix of [`keys/${aliceUid}/`, `media/${aliceUid}/`]) {
            expect(await listRemoteKeys(s3, prefix)).toEqual([]);
        }
        // The handle file still exists (tombstone), and resolve says released.
        expect(
            await listRemoteKeys(s3, `handles/${aliceHandle}.json`),
        ).toHaveLength(1);
        const resolveStatus = await bob.evaluate(async (h) => {
            const res = await fetch(`/v1/resolve/${h}`);
            return res.status;
        }, aliceHandle);
        expect(resolveStatus).toBe(410);

        // Local + UI on device 2: its next request hits the deleted device
        // file → 403 device_revoked (the delete evicted the device cache, so
        // this is prompt) → full logout + redirect. Visit a protected route so
        // the session-null redirect resolves to /login rather than Landing.
        await alice2.goto('/saved');
        await alice2.waitForURL('**/login', { timeout: 30_000 });
        const tokenAfter = await alice2.evaluate(() =>
            localStorage.getItem('atmin:token'),
        );
        expect(tokenAfter).toBeNull();

        await aliceCtx.close();
        await alice2Ctx.close();
        await bobCtx.close();
    });
});
