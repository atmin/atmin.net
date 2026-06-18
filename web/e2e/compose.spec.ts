import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import { expect, test } from '@playwright/test';
import {
    openChat,
    registerUser,
    waitForMediaImage,
    waitForMessage,
} from './helpers';

const PHOTO = join(__dirname, 'fixtures/photo.png');

test.describe('Compose tray', () => {
    test('paste an image → stage → caption → send', async ({ browser }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const aliceHandle = await registerUser(alice);
        const bobHandle = await registerUser(bob);

        await openChat(alice, bobHandle);

        // Simulate a clipboard paste of an image: build a File from the fixture
        // bytes in the page, wrap it in a DataTransfer, and dispatch a synthetic
        // ClipboardEvent on the message box (Chromium honors clipboardData in
        // the constructor). This drives ChatView's onPaste exactly like a real
        // screenshot paste.
        const b64 = readFileSync(PHOTO).toString('base64');
        const input = alice.getByTestId('message-input');
        await input.click();
        await input.evaluate((el, data) => {
            const bin = atob(data);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            const file = new File([bytes], 'pasted.png', { type: 'image/png' });
            const dt = new DataTransfer();
            dt.items.add(file);
            el.dispatchEvent(
                new ClipboardEvent('paste', {
                    clipboardData: dt,
                    bubbles: true,
                    cancelable: true,
                }),
            );
        }, b64);

        // It STAGED, did not send: tray + thumbnail are shown and no message
        // bubble exists yet.
        await expect(alice.getByTestId('compose-tray')).toBeVisible();
        await expect(alice.getByTestId('compose-thumb')).toBeVisible();
        await expect(
            alice.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(0);

        // Type a companion message and send.
        const caption = 'pasted screenshot caption';
        await input.fill(caption);
        const send = alice.getByRole('button', { name: 'Send' });
        await expect(send).toBeEnabled();
        await send.click();

        // Alice's own echo: one image bubble carrying the caption. The tray
        // clears on dispatch.
        await expect(
            alice.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(1, { timeout: 30_000 });
        await waitForMessage(alice, caption);
        await expect(alice.getByTestId('compose-tray')).toHaveCount(0);

        // Bob receives one image bubble with the same caption.
        await openChat(bob, aliceHandle);
        await waitForMediaImage(bob);
        await waitForMessage(bob, caption);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('pick via 📎 → stage → remove → re-stage → send (no caption ⇒ filename)', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const aliceHandle = await registerUser(alice);
        const bobHandle = await registerUser(bob);

        await openChat(alice, bobHandle);

        // Picking stages — it does not send.
        await alice.locator('input[type="file"]').setInputFiles(PHOTO);
        await expect(alice.getByTestId('compose-tray')).toBeVisible();
        await expect(
            alice.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(0);

        // Remove (✕) clears the staged item.
        await alice.getByTestId('compose-remove').click();
        await expect(alice.getByTestId('compose-tray')).toHaveCount(0);

        // Re-stage and send with no caption → body falls back to the filename.
        await alice.locator('input[type="file"]').setInputFiles(PHOTO);
        await expect(alice.getByTestId('compose-tray')).toBeVisible();
        const send = alice.getByRole('button', { name: 'Send' });
        await expect(send).toBeEnabled();
        await send.click();

        await expect(
            alice.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(1, { timeout: 30_000 });
        await waitForMessage(alice, 'photo.png');

        await openChat(bob, aliceHandle);
        await waitForMediaImage(bob);
        await waitForMessage(bob, 'photo.png');

        await aliceCtx.close();
        await bobCtx.close();
    });
});
