import { expect, test } from '@playwright/test';
import {
    deleteMessage,
    editMessage,
    expectConversationPreview,
    getMessageCount,
    gotoChatList,
    loginUser,
    openChat,
    registerUserWithPassword,
    resyncChat,
    sendMedia,
    sendMessage,
    setPhotoQuality,
    waitForDeleted,
    waitForEdited,
    waitForMessage,
} from './helpers';

// Scenario: docs/scenarios/message-amendments.md
test.describe('Message amendments', () => {
    test('Alice edits then deletes a message; Bob sees both', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const { handle: bobHandle } = await registerUserWithPassword(bob);

        // Alice sends, Bob receives.
        await openChat(alice, bobHandle);
        await sendMessage(alice, 'Hi Bob');
        await openChat(bob, aliceHandle);
        await waitForMessage(bob, 'Hi Bob');

        // Alice edits — Bob's view updates with an "(edited)" tag.
        await editMessage(alice, 'Hi Bob', 'Hello Bob');
        await waitForMessage(alice, 'Hello Bob');
        await waitForMessage(bob, 'Hello Bob');
        await waitForEdited(bob, 'Hello Bob');
        // The pre-edit text is gone (replaced, not appended).
        await expect(
            bob.locator('[data-testid="message"]').filter({ hasText: 'Hi Bob' }),
        ).toHaveCount(0);

        // Alice deletes — Bob's view shows [deleted] at the same position.
        await deleteMessage(alice, 'Hello Bob');
        await waitForDeleted(alice);
        await waitForDeleted(bob);
        // Still one bubble — the placeholder occupies the original's slot.
        expect(await getMessageCount(bob)).toBe(1);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('deleting the latest message updates the chat-list preview', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const { handle: bobHandle } = await registerUserWithPassword(bob);

        // Alice sends two messages; Bob's row preview shows the latest.
        await openChat(alice, bobHandle);
        await sendMessage(alice, 'first');
        await sendMessage(alice, 'second');
        await gotoChatList(alice);
        await expectConversationPreview(alice, bobHandle, 'second');

        // Alice deletes the latest message — the preview must show "[deleted]"
        // (mirroring the in-chat placeholder), not keep the deleted text.
        await openChat(alice, bobHandle);
        await deleteMessage(alice, 'second');
        await waitForDeleted(alice);
        await gotoChatList(alice);
        await expectConversationPreview(alice, bobHandle, '[deleted]');

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('edit and delete propagate to the senderʼs other device (self-copy)', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle, password: alicePassword } =
            await registerUserWithPassword(alice);
        const { handle: bobHandle } = await registerUserWithPassword(bob);

        await openChat(alice, bobHandle);
        await sendMessage(alice, 'first draft');
        await editMessage(alice, 'first draft', 'final draft');
        await waitForMessage(alice, 'final draft');

        // Alice's second device logs in and syncs — sees the edited state.
        const alice2Ctx = await browser.newContext();
        const alice2 = await alice2Ctx.newPage();
        await loginUser(alice2, aliceHandle, alicePassword);
        await openChat(alice2, bobHandle);
        await waitForMessage(alice2, 'final draft');
        await waitForEdited(alice2, 'final draft');

        // Delete on device 1 reflects on device 2.
        await deleteMessage(alice, 'final draft');
        await resyncChat(alice2, bobHandle);
        await waitForDeleted(alice2);

        await alice2Ctx.close();
        await aliceCtx.close();
        await bobCtx.close();
    });

    test('an edit that arrives with its original resolves without a flash of the old text', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const { handle: bobHandle } = await registerUserWithPassword(bob);

        // Bob never opens the chat until after both the original and the edit
        // exist server-side, so his first materialization sees them together.
        await openChat(alice, bobHandle);
        await sendMessage(alice, 'X');
        await editMessage(alice, 'X', 'X edited');
        await waitForMessage(alice, 'X edited');

        // Bob's first render of the conversation shows the edited body directly.
        await openChat(bob, aliceHandle);
        await waitForMessage(bob, 'X edited');
        await waitForEdited(bob, 'X edited');
        await expect(
            bob.locator('[data-testid="message"]').filter({ hasText: 'X' }),
        ).toHaveCount(1); // only the "X edited" bubble matches

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('an edit applies across compaction (original archived to CBOR)', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const { handle: bobHandle } = await registerUserWithPassword(bob);

        // Watch for the post-sync auto-compaction that folds Bob's live inbox
        // (including M) into a CBOR archive. Attach the listener BEFORE M is
        // ever sent: the compact fires from Bob's background SSE sync, which can
        // race ahead of a listener attached later (a raw `await` on a missed
        // event would hang to the test timeout with every visible step green).
        let bobCompacted = false;
        bob.on('response', (res) => {
            if (new URL(res.url()).pathname === '/v1/store/compact')
                bobCompacted = true;
        });

        await openChat(alice, bobHandle);
        await sendMessage(alice, 'M');

        await openChat(bob, aliceHandle);
        await waitForMessage(bob, 'M');
        // Bounded — fails fast with a clear message rather than hanging if
        // compaction never runs. M is now out of the live prefix.
        await expect.poll(() => bobCompacted, { timeout: 15_000 }).toBe(true);

        // Alice edits the now-archived original.
        await editMessage(alice, 'M', 'M edited');

        // Bob re-opens the chat: the materializer reads the original from the
        // archive and the amendment from the live inbox, uniformly.
        await resyncChat(bob, aliceHandle);
        await waitForMessage(bob, 'M edited');
        await waitForEdited(bob, 'M edited');

        // And a delete after compaction still lands.
        await deleteMessage(alice, 'M edited');
        await resyncChat(bob, aliceHandle);
        await waitForDeleted(bob);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('deleting a media message drops the attachment and shows [deleted]', async ({
        browser,
    }, testInfo) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const { handle: bobHandle } = await registerUserWithPassword(bob);

        await openChat(alice, bobHandle);

        // Capture the media key from the presign request, and the key of any
        // DELETE /v1/store/object Alice issues, so the test can assert the blob
        // delete fires for exactly that key.
        let mediaKey: string | undefined;
        const deletedKeys: string[] = [];
        alice.on('request', (req) => {
            const u = new URL(req.url());
            if (u.pathname === '/v1/store/presign') {
                try {
                    const body = req.postDataJSON() as { key?: string };
                    if (body?.key?.startsWith('media/')) mediaKey = body.key;
                } catch {
                    // ignore non-JSON
                }
            }
            if (u.pathname === '/v1/store/object' && req.method() === 'DELETE') {
                const key = u.searchParams.get('key');
                if (key) deletedKeys.push(key);
            }
        });

        const fixture = testInfo.outputPath('pixel.png');
        const fs = await import('node:fs/promises');
        // 1x1 transparent PNG.
        await fs.writeFile(
            fixture,
            Buffer.from(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
                'base64',
            ),
        );
        // This test exercises delete, not optimization. Send untouched so it
        // doesn't route through the canvas re-encode — a degenerate 1x1
        // transparent PNG isn't JPEG-encodable, and the optimized default fails
        // closed rather than leak the original (ADR-0022 §5).
        await setPhotoQuality(alice, 'original');
        await sendMedia(alice, fixture);

        await openChat(bob, aliceHandle);
        await expect(
            bob.locator('[data-testid="media-attachment"]').first(),
        ).toBeVisible({ timeout: 15_000 });

        // Alice deletes the media message.
        await alice.locator('[data-testid="message"]').first().hover();
        await alice
            .locator('[data-testid="message"]')
            .first()
            .getByTestId('message-actions-trigger')
            .click();
        await alice.getByTestId('message-action-delete').click();
        await alice.getByTestId('message-delete-confirm').click();

        await waitForDeleted(bob);
        await expect(
            bob.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(0);

        // Alice issued the owner-only DELETE for exactly the uploaded blob.
        // (That the server actually removes it is covered by the Go handler
        // test TestStoreDeleteObject; here we assert the client wiring.)
        expect(mediaKey).toBeTruthy();
        await expect
            .poll(() => deletedKeys, { timeout: 10_000 })
            .toContain(mediaKey);

        await aliceCtx.close();
        await bobCtx.close();
    });
});
