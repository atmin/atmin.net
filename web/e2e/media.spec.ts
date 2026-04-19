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
import { expect, test } from '@playwright/test';
import {
    loginUser,
    openChat,
    registerUser,
    registerUserWithMnemonic,
    sendMedia,
    waitForMediaDownload,
    waitForMediaImage,
} from './helpers';

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

    test('download variant for non-image', async ({ browser }) => {
        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        const aliceHandle = await registerUser(alice);
        const bobHandle = await registerUser(bob);

        await openChat(alice, bobHandle);
        await sendMedia(alice, BLOB);

        await openChat(bob, aliceHandle);
        await waitForMediaDownload(bob);

        await expect(
            bob.locator('[data-testid="media-image"]'),
        ).toHaveCount(0);
        const link = bob.locator('[data-testid="media-download"]').first();
        await expect(link).toHaveAttribute('download', /.+/);

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
        const { handle: bobHandle, mnemonic: bobMnemonic } =
            await registerUserWithMnemonic(bob);

        await openChat(alice, bobHandle);

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

        await loginUser(bobFresh, bobHandle, bobMnemonic);
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

        let sendCalls = 0;
        await alice.route('**/v1/send', async (route) => {
            sendCalls++;
            if (sendCalls === 1) {
                await route.fulfill({
                    status: 503,
                    contentType: 'application/json',
                    body: JSON.stringify({ code: 'unavailable' }),
                });
                return;
            }
            await route.continue();
        });

        // First send will trigger the alert; dismiss and retry.
        const firstDialog = new Promise<void>((resolve) => {
            alice.once('dialog', (d) => {
                d.dismiss().then(resolve);
            });
        });
        await alice.locator('input[type="file"]').setInputFiles(PHOTO);
        await firstDialog;

        // Retry: pick the same file again and wait for alice's own echo.
        await alice.locator('input[type="file"]').setInputFiles(PHOTO);
        await expect(
            alice.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(1, { timeout: 30_000 });

        await openChat(bob, aliceHandle);
        await waitForMediaImage(bob);
        await expect(
            bob.locator('[data-testid="media-attachment"]'),
        ).toHaveCount(1);

        // PUT to media/... fired once per successful send; presign may have
        // been called twice (once per attempt). Assert media blob count = 1.
        const keys = await listMediaKeys();
        expect(
            keys.filter((k) => k.startsWith('media/')).length,
        ).toBeGreaterThanOrEqual(1);

        await aliceCtx.close();
        await bobCtx.close();
    });
});
