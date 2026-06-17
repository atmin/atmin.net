import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
import {
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { expect, type Page, test } from '@playwright/test';
import {
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    sendMedia,
    setPhotoQuality,
    waitForMediaDownload,
    waitForMediaImage,
} from './helpers';

// Send a long-but-bounded message: ~1800 chars wraps to several hundred px in a
// narrow viewport while staying well under the server's 8 KiB `&str` body limit
// on POST /v1/send (a 6 KB+ envelope is rejected with "data limit exceeded").
// A few of these sandwiching an image keep it off-screen at any open scroll
// position — far fewer round-trips than dozens of short sends. Waits on the
// message count, not the long text body.
async function sendTallMessage(page: Page, tag: string): Promise<void> {
    const messages = page.locator('[data-testid="message"]');
    const before = await messages.count();
    await page
        .getByPlaceholder('Type a message...')
        .fill(`${tag} ${'wrap '.repeat(360)}`);
    const send = page.getByRole('button', { name: 'Send' });
    await expect(send).toBeEnabled({ timeout: 15_000 });
    await send.click();
    await expect(messages).toHaveCount(before + 1, { timeout: 15_000 });
}

const PHOTO = join(__dirname, 'fixtures/photo.png');
const BLOB = join(__dirname, 'fixtures/blob.bin');

function sha256(buf: Buffer | Uint8Array): string {
    return createHash('sha256').update(buf).digest('hex');
}

function s3(): S3Client {
    return new S3Client({
        region: 'us-east-1',
        endpoint: 'http://localhost:9000',
        forcePathStyle: true,
        credentials: {
            accessKeyId: 'minioadmin',
            secretAccessKey: 'minioadmin',
        },
    });
}

async function listMediaKeys(): Promise<string[]> {
    const client = s3();
    const bucket = process.env.E2E_BUCKET;
    if (!bucket) throw new Error('E2E_BUCKET not set');
    const out = await client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: 'media/' }),
    );
    return (out.Contents ?? []).map((o) => o.Key as string);
}

test.describe('Media', () => {
    test('inline image + browser cache on refresh', async ({ browser }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const aliceHandle = await registerUser(alice);
        const bobHandle = await registerUser(bob);

        await openChat(alice, bobHandle);
        // Byte-exact round-trip: send the untouched original so the rendered
        // bytes equal photo.png (the default optimized path re-encodes to JPEG).
        await setPhotoQuality(alice, 'original');
        await sendMedia(alice, PHOTO);

        await openChat(bob, aliceHandle);
        await waitForMediaImage(bob);

        // Hash the rendered blob URL bytes and compare to photo.png.
        const renderedHex = await bob.evaluate(async () => {
            const img = document.querySelector(
                '[data-testid="media-image"]',
            ) as HTMLImageElement;
            const res = await fetch(img.src);
            const buf = new Uint8Array(await res.arrayBuffer());
            let hex = '';
            const hash = await crypto.subtle.digest('SHA-256', buf);
            for (const b of new Uint8Array(hash)) {
                hex += b.toString(16).padStart(2, '0');
            }
            return hex;
        });
        expect(renderedHex).toBe(sha256(readFileSync(PHOTO)));

        // Case 2: reload; count network hits (not HTTP cache) for media.
        // page.on('request') fires for cached fetches too, so use CDP
        // Network events which expose `fromDiskCache`.
        const cdp = await bob.context().newCDPSession(bob);
        await cdp.send('Network.enable');
        let mediaNetworkHits = 0;
        cdp.on('Network.responseReceived', (e) => {
            if (
                e.response.url.includes('/v1/store/object') &&
                e.response.url.includes('key=media') &&
                !e.response.fromDiskCache &&
                !e.response.fromPrefetchCache
            ) {
                mediaNetworkHits++;
            }
        });
        await bob.reload();
        await waitForMediaImage(bob);
        expect(mediaNetworkHits).toBe(0);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('non-image renders a chip and fetches only on click', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const aliceHandle = await registerUser(alice);
        const bobHandle = await registerUser(bob);

        await openChat(alice, bobHandle);
        await sendMedia(alice, BLOB);

        // A non-image is never auto-downloaded — count uncached media GETs.
        const cdp = await bob.context().newCDPSession(bob);
        await cdp.send('Network.enable');
        let mediaHits = 0;
        cdp.on('Network.responseReceived', (e) => {
            if (
                e.response.url.includes('/v1/store/object') &&
                e.response.url.includes('key=media') &&
                !e.response.fromDiskCache &&
                !e.response.fromPrefetchCache
            ) {
                mediaHits++;
            }
        });

        await openChat(bob, aliceHandle);

        // The chip shows the filename + size straight from the payload — no
        // image, no download link, and crucially no fetch.
        const chip = bob.locator('[data-testid="media-chip"]').first();
        await expect(chip).toBeVisible({ timeout: 15_000 });
        await expect(bob.locator('[data-testid="media-image"]')).toHaveCount(0);
        await expect(
            bob.locator('[data-testid="media-download"]'),
        ).toHaveCount(0);
        expect(mediaHits, 'chip does not auto-fetch').toBe(0);

        // Clicking the chip fetches + decrypts on demand.
        await chip.click();
        await waitForMediaDownload(bob);
        const link = bob.locator('[data-testid="media-download"]').first();
        await expect(link).toHaveAttribute('download', /.+/);
        expect(mediaHits, 'click fetched exactly once').toBe(1);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('lazy-loads images on scroll — off-screen stays idle until approached', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const aliceHandle = await registerUser(alice);
        const bobHandle = await registerUser(bob);

        await openChat(alice, bobHandle);
        // Sandwich one image between tall filler blocks so it is off-screen at
        // EVERY open scroll position — whether the chat lands at the top or
        // auto-scrolls to the bottom. This removes the open-time race between
        // auto-scroll-to-bottom and the IntersectionObserver's first pass, so
        // we can assert the lazy gate deterministically by driving the scroll
        // ourselves. Two tall sends per side keep the round-trip count low.
        await sendTallMessage(alice, 'top-filler-a');
        await sendTallMessage(alice, 'top-filler-b');
        await sendMedia(alice, PHOTO);
        await sendTallMessage(alice, 'bottom-filler-a');
        await sendTallMessage(alice, 'bottom-filler-b');

        // A small viewport keeps each filler block far taller than the observed
        // region (viewport + 200px rootMargin), so the image between them
        // cannot be reached from either end without scrolling.
        await bob.setViewportSize({ width: 500, height: 400 });

        // Count uncached media object GETs to prove the off-screen image is not
        // fetched until it nears the viewport.
        const cdp = await bob.context().newCDPSession(bob);
        await cdp.send('Network.enable');
        let mediaHits = 0;
        cdp.on('Network.responseReceived', (e) => {
            if (
                e.response.url.includes('/v1/store/object') &&
                e.response.url.includes('key=media') &&
                !e.response.fromDiskCache &&
                !e.response.fromPrefetchCache
            ) {
                mediaHits++;
            }
        });

        await openChat(bob, aliceHandle);

        const image = bob.locator('[data-testid="media-attachment"]');
        await expect(image).toHaveCount(1, { timeout: 15_000 });

        // On open the image is off-screen (only filler is in view) → idle and
        // never fetched.
        await expect(image).toHaveAttribute('data-status', 'idle');
        expect(mediaHits, 'off-screen image is not fetched on open').toBe(0);

        // Scrolling it toward the viewport triggers the lazy fetch.
        await image.scrollIntoViewIfNeeded();
        await expect(image).toHaveAttribute('data-status', 'ready', {
            timeout: 15_000,
        });
        expect(mediaHits, 'approaching the image fetched it once').toBe(1);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('oversize rejected client-side — no presign hit', async ({
        browser,
    }) => {
        const huge = join(tmpdir(), `huge-${Date.now()}.bin`);
        writeFileSync(huge, Buffer.alloc(26 * 1024 * 1024));

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const aliceHandle = await registerUser(alice);
        const bobHandle = await registerUser(bob);

        await openChat(alice, bobHandle);

        let presignHits = 0;
        alice.on('request', (req) => {
            if (
                req.method() === 'POST' &&
                req.url().includes('/v1/store/presign') &&
                (req.postData() ?? '').includes('"key":"media/')
            ) {
                presignHits++;
            }
        });
        // useChat.sendMedia surfaces the failure via window.alert.
        const dialogSeen = new Promise<void>((resolve) => {
            alice.once('dialog', (d) => {
                d.dismiss().then(resolve);
            });
        });
        await alice.locator('input[type="file"]').setInputFiles(huge);
        await dialogSeen;

        expect(presignHits).toBe(0);

        // Sanity: Bob, on opening chat, sees no media attachment.
        await openChat(bob, aliceHandle);
        await expect(
            bob.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(0);

        await aliceCtx.close();
        await bobCtx.close();
    });

    test('corrupt blob surfaces data-status=corrupt', async ({ browser }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const aliceHandle = await registerUser(alice);
        const { handle: bobHandle, password: bobPassword } =
            await registerUserWithPassword(bob);

        await openChat(alice, bobHandle);
        // Send the untouched original so `ciphertextLen` (source bytes + GCM
        // tag) matches the stored object exactly; the default optimized path
        // re-encodes to a smaller JPEG of unknown length.
        await setPhotoQuality(alice, 'original');

        // Capture the media key from alice's presign body so we know which
        // blob to overwrite (the bucket may contain keys from earlier tests).
        let capturedKey: string | null = null;
        alice.on('request', (req) => {
            if (
                capturedKey === null &&
                req.method() === 'POST' &&
                req.url().includes('/v1/store/presign')
            ) {
                const body = req.postData() ?? '';
                const m = body.match(/"key":"(media\/[^"]+)"/);
                if (m) capturedKey = m[1];
            }
        });

        await sendMedia(alice, PHOTO);

        await openChat(bob, aliceHandle);
        await waitForMediaImage(bob);

        if (!capturedKey) throw new Error('did not capture media presign key');
        const key = capturedKey;
        const ciphertextLen = readFileSync(PHOTO).byteLength + 16;

        // Overwrite the blob in S3 so the server-side object is corrupt.
        const client = s3();
        const bucket = process.env.E2E_BUCKET as string;
        await client.send(
            new PutObjectCommand({
                Bucket: bucket,
                Key: key,
                Body: randomBytes(ciphertextLen),
                ContentType: 'application/octet-stream',
            }),
        );

        const bobFreshCtx = await browser.newContext();
        const bobFresh = await bobFreshCtx.newPage();

        // Playwright contexts within the same browser process share Chromium's
        // disk cache. The server sends Cache-Control: immutable for media
        // objects, so bobCtx's successful fetch may be served from disk cache
        // to bobFreshCtx, bypassing the S3 corruption above. Route the specific
        // key through Playwright instead — intercepted requests skip the cache.
        await bobFreshCtx.route(
            (url) =>
                new URL(url).pathname === '/v1/store/object' &&
                new URL(url).searchParams.get('key') === key,
            (route) =>
                route.fulfill({
                    status: 200,
                    contentType: 'application/octet-stream',
                    body: Buffer.from(randomBytes(ciphertextLen)),
                }),
        );

        await loginUser(bobFresh, bobHandle, bobPassword);
        await openChat(bobFresh, aliceHandle);

        const attach = bobFresh
            .locator('[data-testid="media-attachment"]')
            .first();
        await expect(attach).toHaveAttribute('data-status', 'corrupt', {
            timeout: 15_000,
        });
        await expect(
            bobFresh.locator('[data-testid="message"]').first(),
        ).toBeVisible();

        await bobFreshCtx.close();
        await aliceCtx.close();
        await bobCtx.close();
    });

    test('send succeeds once after a transient /v1/send 503', async ({
        browser,
    }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const aliceHandle = await registerUser(alice);
        const bobHandle = await registerUser(bob);

        await openChat(alice, bobHandle);

        // A transient 503 on the first /v1/send is now retried idempotently
        // inside send() (same msg_id), so the attach succeeds with no
        // user-visible error and no manual retry. The envelope POST is
        // retried; the media blob is uploaded only once (the retry doesn't
        // re-run presign/PUT).
        let sendCalls = 0;
        await alice.route('**/v1/send', async (route) => {
            sendCalls++;
            if (sendCalls === 1) {
                await route.fulfill({
                    status: 503,
                    contentType: 'application/json',
                    body: JSON.stringify({
                        error: 'unavailable',
                        message: 'transient',
                    }),
                });
                return;
            }
            await route.continue();
        });

        // The retry is transparent — no error alert should appear.
        let dialogFired = false;
        alice.on('dialog', (d) => {
            dialogFired = true;
            d.dismiss();
        });

        await alice.locator('input[type="file"]').setInputFiles(PHOTO);

        // Alice's own echo appears exactly once after the internal retry.
        await expect(
            alice.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(1, { timeout: 30_000 });
        expect(sendCalls, 'one 503 then one successful retry').toBe(2);
        expect(dialogFired, 'no error alert on a transient 503').toBe(false);

        await openChat(bob, aliceHandle);
        await waitForMediaImage(bob);
        await expect(
            bob.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(1);

        // The blob was uploaded exactly once — the retry re-sends only the
        // envelope, not the media. Scope to Alice's own prefix: the e2e
        // bucket is shared across the whole suite, so a global `media/`
        // count would include other tests' blobs.
        const aliceUid = await alice.evaluate(() =>
            localStorage.getItem('atmin:userId'),
        );
        const keys = await listMediaKeys();
        expect(
            keys.filter((k) => k.startsWith(`media/${aliceUid}/`)).length,
        ).toBe(1);

        await aliceCtx.close();
        await bobCtx.close();
    });
});
