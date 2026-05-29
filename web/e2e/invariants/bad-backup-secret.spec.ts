/**
 * I6 — Bad credential / corrupt backup fails legibly
 *
 * Two distinct, non-silent failure modes:
 *  - Wrong password → login is rejected; no session is established.
 *  - Correct password against a corrupted key-backup blob → login still
 *    succeeds (one bad blob must not block everything), restore skips the
 *    blob, COUNTS it, and surfaces a visible "couldn't be restored" signal.
 *
 * The second half is the load-bearing one: before this, a corrupt blob was
 * silently dropped (console.error only), so history could vanish with no
 * user-facing trace. See docs/scenarios/invariants/i6-bad-credential-corrupt-backup.md.
 */

import {
    GetObjectCommand,
    type GetObjectCommandOutput,
    PutObjectCommand,
} from '@aws-sdk/client-s3';
import { expect, test } from '@playwright/test';
import {
    E2E_PASSWORD,
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    sendMessage,
    waitForMessage,
} from '../helpers';
import { getCurrentUserId, listRemoteKeys, makeS3Client } from './helpers';

test.describe('I6 — bad credential / corrupt backup fails legibly', () => {
    test('wrong password is rejected; no session established', async ({
        browser,
    }) => {
        // Argon2id on the wrong password + the add-device round trip.
        test.setTimeout(90_000);

        const aliceCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const { handle } = await registerUserWithPassword(alice);
        await aliceCtx.close();

        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await fresh.goto('/login');
        await fresh.fill('#handle', handle);
        await fresh.fill('#secret', 'definitely-not-the-password-9');
        await fresh.getByRole('button', { name: 'Sign In' }).click();

        // Wrong password derives the wrong auth key, so add-device's auth
        // proof fails verification → 403 → the form shows "Login Failed"
        // and stays on /login. No redirect, no session.
        await expect(fresh.getByText('Login Failed')).toBeVisible({
            timeout: 60_000,
        });
        expect(fresh.url()).toContain('/login');
        const persistedUid = await fresh.evaluate(() =>
            localStorage.getItem('atmin:userId'),
        );
        expect(persistedUid, 'no session persisted on failed login').toBeNull();

        await freshCtx.close();
    });

    test('correct password + corrupt key-backup blob → login succeeds with a visible restore warning', async ({
        browser,
    }) => {
        test.setTimeout(120_000);

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // ── 1. Register both; Bob → Alice one message ────────────────
        const { handle: aliceHandle } = await registerUserWithPassword(alice);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);

        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'hello');
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'hello');

        // ── 2. Wait until Alice has backed up the inbound session key ─
        // The backup is fire-and-forget after receipt; poll S3 until the
        // blob exists under Alice's key-backup prefix.
        const s3 = makeS3Client();
        let liveKeys: string[] = [];
        await expect
            .poll(
                async () => {
                    liveKeys = await listRemoteKeys(
                        s3,
                        `keys/${aliceUid}/live/`,
                    );
                    return liveKeys.length;
                },
                { timeout: 20_000 },
            )
            .toBeGreaterThan(0);

        // Close the original devices so no background write races the
        // corruption we're about to inject.
        await aliceCtx.close();
        await bobCtx.close();

        // ── 3. Corrupt the ciphertext of one key-backup blob ─────────
        // Keep the envelope shape valid ({v, iv, ciphertext}) so it parses
        // and reaches AES-GCM, which then fails the auth tag → the blob is
        // counted as a failed restore, not a parse error.
        const target = liveKeys[0];
        const env = JSON.parse(await getObject(s3, target)) as {
            v: number;
            iv: string;
            ciphertext: string;
        };
        env.ciphertext = Buffer.from('corrupted').toString('base64'); // valid b64, too short to be a real GCM payload
        await putObject(s3, target, JSON.stringify(env));

        // ── 4. Fresh device, CORRECT password ────────────────────────
        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await loginUser(fresh, aliceHandle, E2E_PASSWORD); // resolves on home → login succeeded

        // ── 5. Login succeeded, and the loss is surfaced, not silent ─
        const warning = fresh.getByTestId('restore-warning');
        await expect(warning).toBeVisible({ timeout: 30_000 });
        await expect(warning).toContainText(/couldn't be restored/i);
        // Client is still functional — the warning is dismissible.
        await fresh.getByRole('button', { name: 'Dismiss' }).click();
        await expect(warning).toBeHidden();

        await freshCtx.close();
    });
});

async function getObject(
    s3: ReturnType<typeof makeS3Client>,
    key: string,
): Promise<string> {
    const bucket = process.env.E2E_BUCKET;
    if (!bucket) throw new Error('E2E_BUCKET not set');
    const out: GetObjectCommandOutput = await s3.send(
        new GetObjectCommand({ Bucket: bucket, Key: key }),
    );
    if (!out.Body) throw new Error(`no body for ${key}`);
    return out.Body.transformToString();
}

async function putObject(
    s3: ReturnType<typeof makeS3Client>,
    key: string,
    body: string,
): Promise<void> {
    const bucket = process.env.E2E_BUCKET;
    if (!bucket) throw new Error('E2E_BUCKET not set');
    await s3.send(
        new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: body,
            ContentType: 'application/json',
        }),
    );
}
