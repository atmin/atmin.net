/**
 * I13 — Media quota is enforced, legible, and freed by delete
 *
 * The 1000-blob cap is the seedable boundary (a byte-quota seed would be a
 * ~1 GiB write); DeniedBytes/DeniedCount share the same 413 surface and are
 * split only for logging, unit-tested in server/src/media_quota.rs. Seed
 * media/{uid}/ to one below the cap before the account's first media action
 * (the first quota probe lists real S3), cross the cap, get denied loudly,
 * delete media, get granted again.
 *
 * See docs/scenarios/invariants/i13-media-quota.md.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page, test } from '@playwright/test';
import {
    deleteMessage,
    openChat,
    registerUser,
    registerUserWithPassword,
    sendMedia,
    sendMessage,
    waitForDeleted,
    waitForMessage,
} from '../helpers';
import {
    getCurrentUserId,
    listRemoteKeys,
    makeS3Client,
    putObject,
} from './helpers';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PHOTO = join(__dirname, '../fixtures/photo.png');

/** One below the server's USER_MEDIA_BLOB_CAP (server/src/media_quota.rs). */
const SEED_COUNT = 999;

/**
 * Stage a file and press Send, expecting the quota alert instead of an echo
 * (useChat.sendMedia surfaces upload failures via window.alert). Clears the
 * staged item afterwards so the tray is clean for later sends.
 */
async function sendMediaExpectingRejection(
    page: Page,
    filePath: string,
): Promise<string> {
    const alerted = new Promise<string>((resolve) => {
        page.once('dialog', (d) => {
            const text = d.message();
            void d.dismiss().then(() => resolve(text));
        });
    });
    await page.locator('input[type="file"]').setInputFiles(filePath);
    await expect(page.getByTestId('compose-tray')).toBeVisible({
        timeout: 15_000,
    });
    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeEnabled({ timeout: 15_000 });
    await send.click();
    const message = await alerted;
    if (await page.getByTestId('compose-tray').isVisible()) {
        await page.getByTestId('compose-remove').click();
    }
    return message;
}

test.describe('I13 — media quota', () => {
    test('the blob cap denies loudly, leaves no partial state, and a delete frees it', async ({
        browser,
    }) => {
        test.setTimeout(240_000);

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);

        // Seed Alice's media prefix to one below the cap — directly in S3,
        // before her first media action, so the server's first quota probe
        // (an S3 list on cache miss) sees the seeded reality.
        const s3 = makeS3Client();
        const BATCH = 50;
        for (let i = 0; i < SEED_COUNT; i += BATCH) {
            const n = Math.min(BATCH, SEED_COUNT - i);
            await Promise.all(
                Array.from({ length: n }, (_, j) =>
                    putObject(
                        s3,
                        `media/${aliceUid}/seed-${String(i + j).padStart(4, '0')}`,
                        'x',
                        'application/octet-stream',
                    ),
                ),
            );
        }

        await openChat(alice, bobHandle);

        // Blob #1000 — exactly at the cap — is granted and delivers.
        await sendMedia(alice, PHOTO, 'at-the-cap');
        await openChat(bob, aliceHandle);
        await waitForMessage(bob, 'at-the-cap');

        // Blob #1001 is denied at presign (413 quota_exceeded): a visible
        // alert, no new bubble, and no object landed.
        await sendMediaExpectingRejection(alice, PHOTO);
        await expect(
            alice.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(1);
        expect(
            (await listRemoteKeys(s3, `media/${aliceUid}/`)).length,
            'no blob landed past the cap',
        ).toBe(SEED_COUNT + 1);

        // The denial gates media only — text still flows both ways.
        await sendMessage(alice, 'text-still-flows');
        await waitForMessage(bob, 'text-still-flows');

        // Deleting the media message sweeps its blob and invalidates the
        // usage cache: the very next upload re-probes S3 and is granted.
        await deleteMessage(alice, 'at-the-cap');
        await waitForDeleted(alice);
        await expect
            .poll(
                async () =>
                    (await listRemoteKeys(s3, `media/${aliceUid}/`)).length,
                { timeout: 20_000 },
            )
            .toBe(SEED_COUNT);

        await sendMedia(alice, PHOTO, 'after-the-free');
        await waitForMessage(bob, 'after-the-free');
        await expect
            .poll(
                async () =>
                    (await listRemoteKeys(s3, `media/${aliceUid}/`)).length,
                { timeout: 20_000 },
            )
            .toBe(SEED_COUNT + 1);

        await aliceCtx.close();
        await bobCtx.close();
    });
});
