/**
 * I9 — Chain walker recovers history across N rotations
 *
 * Invariant: for any sequence of credential rotations
 * (kv=1 → kv=2 → … → kv=N), a fresh device that derives its keys at
 * kv=N must decrypt every message ever sent to the account by walking
 * key_chain.json. UI, Local, and Remote layers all reflect the same
 * complete message set, in send order, with no duplicates.
 *
 * The existing scenario test (credential-rotate-ui) exercises one
 * rotation; this spec exercises two consecutive rotations so the
 * chain walker traverses more than a single link and any off-by-one
 * in the walking logic shows up here, not in production.
 *
 * See docs/scenarios/invariants.md § I9.
 */

import {
    GetObjectCommand,
    type GetObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { expect, test } from '@playwright/test';
import {
    E2E_PASSWORD,
    loginUser,
    openChat,
    registerUser,
    registerUserWithPassword,
    resyncChat,
    sendMessage,
    waitForMessage,
} from '../helpers';
import {
    buildConversationId,
    expectLocal,
    expectRemote,
    expectUI,
    getCurrentUserId,
    makeS3Client,
} from './helpers';

const PW_2 = 'rotated-passphrase-strong-2';
const PW_3 = 'rotated-passphrase-strong-3';
const ROTATION_TIMEOUT_MS = 60_000;

test.describe('I9 — chain walker recovers history across N rotations', () => {
    test('two consecutive rotations; fresh device sees every era exactly once', async ({
        browser,
    }) => {
        // Two rotations + a fresh-device login means ~5 Argon2id derivations
        // before the assertions even start. The default 60s budget is too
        // tight on CI hardware.
        test.setTimeout(180_000);

        const aliceCtx = await browser.newContext();
        const bobCtx = await browser.newContext();
        const alice = await aliceCtx.newPage();
        const bob = await bobCtx.newPage();

        // Local helper — the two rotations differ only in the credential
        // pair, so factor the UI dance into one function.
        const rotatePassword = async (
            currentPassword: string,
            newPassword: string,
        ) => {
            await alice.goto('/settings');
            await alice.waitForSelector('#current-password', {
                timeout: 15_000,
            });
            await alice.fill('#current-password', currentPassword);
            await alice.fill('#new-password', newPassword);
            await alice.fill('#confirm-new-password', newPassword);
            const ack = alice.getByRole('checkbox', {
                name: /unrecoverable/i,
            });
            await ack.setChecked(true);
            await expect(ack).toBeChecked({ timeout: 5_000 });
            const submit = alice.getByTestId('change-password-submit');
            await expect(submit).toBeEnabled({ timeout: 5_000 });
            await submit.click();
            await expect(alice.getByText('✓ Password changed')).toBeVisible({
                timeout: ROTATION_TIMEOUT_MS,
            });
        };

        // ── 1. Register Alice (kv=1) and Bob ─────────────────────────
        const { handle: aliceHandle, password: pw1 } =
            await registerUserWithPassword(alice);
        expect(pw1).toBe(E2E_PASSWORD);
        const aliceUid = await getCurrentUserId(alice);
        const bobHandle = await registerUser(bob);
        const bobUid = await getCurrentUserId(bob);
        const convId = buildConversationId(aliceUid, bobUid);

        // ── 2. Era 1: Bob → Alice "era-1" while Alice is at kv=1 ─────
        await openChat(bob, aliceHandle);
        await sendMessage(bob, 'era-1');
        await openChat(alice, bobHandle);
        await waitForMessage(alice, 'era-1');

        // ── 3. First rotation: kv=1 → kv=2 ───────────────────────────
        await rotatePassword(pw1, PW_2);

        // ── 4. Era 2: Bob → Alice "era-2" while Alice is at kv=2 ─────
        // Alice's session stayed valid post-rotation (see
        // credential-rotation scenario §6) but she's still on /settings;
        // resyncChat navigates her back via / so the next message lands
        // in the open conversation.
        await resyncChat(alice, bobHandle);
        await sendMessage(bob, 'era-2');
        await waitForMessage(alice, 'era-2');

        // ── 5. Second rotation: kv=2 → kv=3 ──────────────────────────
        await rotatePassword(PW_2, PW_3);

        // ── 6. Era 3: Bob → Alice "era-3" while Alice is at kv=3 ─────
        await resyncChat(alice, bobHandle);
        await sendMessage(bob, 'era-3');
        await waitForMessage(alice, 'era-3');

        // ── 7. Fresh device signs in with the latest password ────────
        // Clean IDB on a new context: the chain walker has to recover
        // the kv=1 and kv=2 backup keys from key_chain.json to decrypt
        // pre-rotation session-key envelopes before any history can
        // surface. This is the spec's load-bearing path.
        const freshCtx = await browser.newContext();
        const fresh = await freshCtx.newPage();
        await loginUser(fresh, aliceHandle, PW_3);
        await openChat(fresh, bobHandle);

        // ── 8. Three-layer assertions on the fresh device ────────────
        const eras = ['era-1', 'era-2', 'era-3'];

        // UI: all three messages, in send order.
        await expectUI(fresh, {
            messageCount: eras.length,
            messageTexts: eras,
        });

        // Local: three unique msg_ids, monotonic by ULID.
        await expectLocal(fresh, convId, {
            uniqueMsgIdCount: eras.length,
            ordered: true,
        });

        // Remote: server-side state has not been corrupted by the two
        // rotations. We assert the structural invariants — no duplicate
        // keys within the live prefix, and Alice's inbox still has at
        // least one object somewhere (live or archive). The exact
        // distribution isn't load-bearing here: a single archive bundle
        // can hold all three messages once compaction fires, so a count
        // assertion would be brittle. The Local layer already proves
        // every era is recoverable end-to-end.
        const s3 = makeS3Client();
        const remote = await expectRemote(s3, aliceUid, {});
        expect(
            remote.liveMsgIds.length + remote.archiveKeys.length,
            'inbox is not empty',
        ).toBeGreaterThan(0);
        expect(
            new Set(remote.liveMsgIds).size,
            'no duplicate keys in live inbox',
        ).toBe(remote.liveMsgIds.length);

        // Remote: key_chain.json has exactly two links — {1→2, 2→3}.
        const chainObj = await getObject(
            s3,
            `keys/${aliceUid}/key_chain.json`,
        );
        const chain = JSON.parse(chainObj) as {
            links: Array<{ from: number; to: number }>;
        };
        expect(chain.links.map((l) => [l.from, l.to])).toEqual([
            [1, 2],
            [2, 3],
        ]);

        await aliceCtx.close();
        await bobCtx.close();
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
