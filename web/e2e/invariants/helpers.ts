import {
    GetObjectCommand,
    type GetObjectCommandOutput,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client,
} from '@aws-sdk/client-s3';
import { expect, type Page } from '@playwright/test';
import { decode as cborDecode, encode as cborEncode } from 'cbor-x';

const MSG_SELECTOR = '[data-testid="message"]';

// ── Infrastructure ────────────────────────────────────────────────

/** S3Client pointed at the local MinIO instance used by e2e tests. */
export function makeS3Client(): S3Client {
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

/** Read the logged-in user's ID from the page's localStorage. */
export async function getCurrentUserId(page: Page): Promise<string> {
    const uid = await page.evaluate(() => localStorage.getItem('atmin:userId'));
    if (!uid) throw new Error('no atmin:userId in localStorage');
    return uid;
}

/**
 * Build the IDB conversationId used by the messaging layer.
 * Mirrors conversationId() in web/src/lib/messaging.ts.
 */
export function buildConversationId(uidA: string, uidB: string): string {
    if (uidA === uidB) return `self:${uidA}`;
    const [a, b] = [uidA, uidB].sort();
    return `dm:${a}:${b}`;
}

// ── UI layer (what the user sees) ─────────────────────────────────

export async function expectUI(
    page: Page,
    opts: {
        /** Exact count of visible message bubbles. */
        messageCount?: number;
        /**
         * Assert these texts are visible and appear in this order
         * among all rendered message bubbles.
         */
        messageTexts?: string[];
    },
): Promise<void> {
    if (opts.messageCount !== undefined) {
        await expect(page.locator(MSG_SELECTOR)).toHaveCount(
            opts.messageCount,
            { timeout: 15_000 },
        );
    }
    if (opts.messageTexts) {
        for (const text of opts.messageTexts) {
            await expect(
                page.locator(MSG_SELECTOR).filter({ hasText: text }),
            ).toBeVisible({ timeout: 15_000 });
        }
        // Use p:first-child to get only the message text, not the
        // concatenated text+timestamp that allTextContents() returns
        // on the bubble element itself.
        const rendered = await page
            .locator(`${MSG_SELECTOR} p:first-child`)
            .allTextContents();
        const filtered = rendered
            .map((t) => t.trim())
            .filter((t) => opts.messageTexts!.includes(t));
        expect(filtered).toEqual(opts.messageTexts);
    }
}

// ── Local layer (IndexedDB) ────────────────────────────────────────

export interface LocalMessageState {
    /** All msg_ids for the conversation, sorted by ULID (ascending). */
    ids: string[];
    /** Number of distinct msg_ids — must equal ids.length if no dups. */
    uniqueIdCount: number;
    /** True when ids are in strict ULID lexicographic order. */
    orderedMonotonically: boolean;
}

export async function expectLocal(
    page: Page,
    conversationId: string,
    opts: {
        /**
         * Assert no duplicates and exactly this many unique msg_ids.
         * Fails if ids.length !== uniqueIdCount (i.e. any duplicate present).
         */
        uniqueMsgIdCount?: number;
        /** Assert ids are in strict ULID lexicographic order. */
        ordered?: boolean;
    },
): Promise<LocalMessageState> {
    const state = await page.evaluate(
        (convId: string): Promise<LocalMessageState> => {
            return new Promise<LocalMessageState>((resolve, reject) => {
                const req = indexedDB.open('atmin');
                req.onerror = () => reject(req.error);
                req.onsuccess = () => {
                    const db = req.result;
                    const tx = db.transaction('messages', 'readonly');
                    const allReq = tx.objectStore('messages').getAll();
                    allReq.onsuccess = () => {
                        const rows: Array<{
                            id: string;
                            conversationId: string;
                        }> = allReq.result;
                        const ids = rows
                            .filter((r) => r.conversationId === convId)
                            .map((r) => r.id)
                            .sort((a, b) => a.localeCompare(b));
                        const uniqueIdCount = new Set(ids).size;
                        let orderedMonotonically = true;
                        for (let i = 1; i < ids.length; i++) {
                            if (ids[i] <= ids[i - 1]) {
                                orderedMonotonically = false;
                                break;
                            }
                        }
                        resolve({ ids, uniqueIdCount, orderedMonotonically });
                    };
                    allReq.onerror = () => reject(allReq.error);
                };
            });
        },
        conversationId,
    );

    if (opts.uniqueMsgIdCount !== undefined) {
        expect(state.uniqueIdCount, 'unique msg_id count').toBe(
            opts.uniqueMsgIdCount,
        );
        expect(state.ids, 'no duplicate msg_ids in IDB').toHaveLength(
            state.uniqueIdCount,
        );
    }
    if (opts.ordered) {
        expect(state.orderedMonotonically, 'IDB msg_ids in ULID order').toBe(
            true,
        );
    }

    return state;
}

// ── Remote layer (S3 / MinIO) ──────────────────────────────────────

/** List all object keys under a prefix in the e2e bucket (paginated). */
export async function listRemoteKeys(
    s3: S3Client,
    prefix: string,
): Promise<string[]> {
    const bucket = process.env.E2E_BUCKET;
    if (!bucket) throw new Error('E2E_BUCKET not set');

    const keys: string[] = [];
    let token: string | undefined;
    do {
        const res = await s3.send(
            new ListObjectsV2Command({
                Bucket: bucket,
                Prefix: prefix,
                ContinuationToken: token,
            }),
        );
        for (const obj of res.Contents ?? []) {
            if (obj.Key) keys.push(obj.Key);
        }
        token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);

    return keys;
}

export interface RemoteInboxState {
    /** msg_ids present in inbox/{uid}/live/. */
    liveMsgIds: string[];
    /** msg_ids extracted from inbox/{uid}/archive/ objects (key only, not body). */
    archiveKeys: string[];
}

export async function expectRemote(
    s3: S3Client,
    uid: string,
    opts: {
        /** Exact count of live inbox objects. */
        inboxLiveCount?: number;
        /** Assert live inbox is empty. */
        inboxLiveNone?: boolean;
        /**
         * Assert these specific msg_ids are present in the live inbox.
         * Also asserts no duplicates within the live prefix.
         */
        inboxLiveMsgIds?: string[];
        /** Exact count of archive objects (CBOR bundles, not individual messages). */
        archiveCount?: number;
    },
): Promise<RemoteInboxState> {
    const [liveKeys, archiveKeys] = await Promise.all([
        listRemoteKeys(s3, `inbox/${uid}/live/`),
        listRemoteKeys(s3, `inbox/${uid}/archive/`),
    ]);

    const liveMsgIds = liveKeys.map((k) => k.split('/').pop()!);

    if (opts.inboxLiveNone) {
        expect(liveMsgIds, 'live inbox should be empty').toHaveLength(0);
    }
    if (opts.inboxLiveCount !== undefined) {
        expect(liveMsgIds, 'live inbox object count').toHaveLength(
            opts.inboxLiveCount,
        );
    }
    if (opts.inboxLiveMsgIds) {
        for (const id of opts.inboxLiveMsgIds) {
            expect(liveMsgIds, `msg_id ${id} in live inbox`).toContain(id);
        }
        expect(
            new Set(liveMsgIds).size,
            'no duplicate keys in live inbox',
        ).toBe(liveMsgIds.length);
    }
    if (opts.archiveCount !== undefined) {
        expect(archiveKeys, 'archive object count').toHaveLength(
            opts.archiveCount,
        );
    }

    return { liveMsgIds, archiveKeys };
}

// ── Remote object read/write (raw) ─────────────────────────────────

function e2eBucket(): string {
    const b = process.env.E2E_BUCKET;
    if (!b) throw new Error('E2E_BUCKET not set');
    return b;
}

/** GET an object's body as text. */
export async function getObject(s3: S3Client, key: string): Promise<string> {
    const out: GetObjectCommandOutput = await s3.send(
        new GetObjectCommand({ Bucket: e2eBucket(), Key: key }),
    );
    if (!out.Body) throw new Error(`no body for ${key}`);
    return out.Body.transformToString();
}

/** GET an object's body as raw bytes (e.g. a CBOR archive bundle). */
export async function getObjectBytes(
    s3: S3Client,
    key: string,
): Promise<Uint8Array> {
    const out: GetObjectCommandOutput = await s3.send(
        new GetObjectCommand({ Bucket: e2eBucket(), Key: key }),
    );
    if (!out.Body) throw new Error(`no body for ${key}`);
    return out.Body.transformToByteArray();
}

/** PUT an object (text or bytes). Defaults to application/json. */
export async function putObject(
    s3: S3Client,
    key: string,
    body: string | Uint8Array,
    contentType = 'application/json',
): Promise<void> {
    await s3.send(
        new PutObjectCommand({
            Bucket: e2eBucket(),
            Key: key,
            Body: body,
            ContentType: contentType,
        }),
    );
}

// ── Fault injection ────────────────────────────────────────────────

// Valid base64, but too short to be a real GCM payload → AES-GCM auth fails.
const CORRUPT_CIPHERTEXT = Buffer.from('corrupted').toString('base64');

/**
 * Mangle the ciphertext of every key-backup blob under `keys/{uid}/`,
 * handling both shapes it can take: a `live/` JSON envelope and an
 * `archive/` CBOR bundle (array of envelopes). Each envelope keeps its
 * `{v, iv, ciphertext}` shape, so restore parses it and fails at AES-GCM
 * decrypt — counted as a failed restore (not a parse error), which is what
 * surfaces the user-facing "couldn't be restored" warning. Returns the
 * number of blobs touched.
 *
 * Why both shapes: a received session key lands in `live/` but the
 * recipient's sync compacts it into an `archive/` bundle, so where it sits
 * is timing-dependent. Poll `keys/{uid}/` for >0 and close the client's
 * context first (freezing compaction) before calling this.
 */
export async function corruptKeyBackups(
    s3: S3Client,
    uid: string,
): Promise<number> {
    const keys = await listRemoteKeys(s3, `keys/${uid}/`);
    let corrupted = 0;
    for (const key of keys) {
        if (key.includes('/live/')) {
            const env = JSON.parse(await getObject(s3, key)) as {
                ciphertext: string;
            };
            env.ciphertext = CORRUPT_CIPHERTEXT;
            await putObject(s3, key, JSON.stringify(env));
            corrupted += 1;
        } else if (key.includes('/archive/')) {
            const entries = cborDecode(await getObjectBytes(s3, key)) as Array<
                Record<string, unknown>
            >;
            for (const entry of entries) {
                if (typeof entry.ciphertext === 'string') {
                    entry.ciphertext = CORRUPT_CIPHERTEXT;
                }
            }
            await putObject(s3, key, cborEncode(entries), 'application/cbor');
            corrupted += 1;
        }
    }
    return corrupted;
}
