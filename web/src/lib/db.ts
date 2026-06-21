/**
 * IndexedDB storage for atmin.net
 * - 'keys' store: CryptoKey objects
 * - 'messages' store: Encrypted messages
 * - 'conversations' store: Per-conversation summary (last message, count)
 * - 'contacts' store: userId → handle cache
 * - 'megolm_outbound' store: Active outbound Megolm session
 * - 'megolm_inbound' store: Inbound Megolm sessions (one per sender session)
 * - 'megolm_key_shares' store: Track which recipients have the session key
 * - 'sync_cursors' store: Persist sync cursors for incremental inbox fetching
 * - 'pending_key_backups' store: Session keys whose backup upload failed,
 *   queued for retry on the next sync (I10 — no silent backup loss)
 * - 'ingested_archives' store: Full S3 keys of inbox archives whose every
 *   message is durably materialized in IndexedDB — safe to skip re-downloading
 *   on the next sync (archive-ingest cache)
 * - 'media_cache' store: Decrypted media blobs (previews + below-threshold
 *   smalls + receiver-derived thumbnails) keyed by S3 URL, for offline media
 *   browsing (ADR-0022 §7). Best-effort — a miss re-fetches from S3.
 */

import { isAmendment, parseInner } from './payload';

const DB_NAME = 'atmin';
const DB_VERSION = 9;
const KEYS_STORE = 'keys';
const MESSAGES_STORE = 'messages';
const CONVERSATIONS_STORE = 'conversations';
const CONTACTS_STORE = 'contacts';
const MEGOLM_OUTBOUND_STORE = 'megolm_outbound';
const MEGOLM_INBOUND_STORE = 'megolm_inbound';
const MEGOLM_KEY_SHARES_STORE = 'megolm_key_shares';
const SYNC_CURSORS_STORE = 'sync_cursors';
const BACKUP_KEYS_STORE = 'backup_keys_by_version';
const PENDING_KEY_BACKUPS_STORE = 'pending_key_backups';
const INGESTED_ARCHIVES_STORE = 'ingested_archives';
const MEDIA_CACHE_STORE = 'media_cache';

export interface StoredOutboundSession {
    id: 'current';
    pickleJson: string;
    sessionId: string;
    messageIndex: number;
}

export interface StoredInboundSession {
    sessionId: string;
    fromUser: string;
    fromDevice: string;
    pickleJson: string;
}

export interface StoredKeyShare {
    sessionId: string;
    recipientUserId: string;
    sharedAt: number;
}

export interface StoredMessage {
    id: string; // msg_id, primary key
    userId: string; // The user's inbox this message is in
    conversationId: string; // e.g. "self:U1" or "dm:U1:U2"
    fromUser: string;
    fromDevice: string;
    text: string;
    timestamp: number; // milliseconds since epoch
}

export interface StoredConversation {
    conversationId: string;
    lastMessageText: string;
    lastMessageTimestamp: number; // ms epoch
    messageCount: number;
}

export interface StoredContact {
    userId: string;
    handle: string;
}

export interface StoredSyncCursor {
    prefix: string;
    cursor: string;
}

/**
 * A session key whose backup upload failed (hard error after putWithRetry),
 * queued for retry on the next sync so the failure is never silent (I10).
 * Holds the session key material — same exposure class as the inbound-session
 * pickle already in IDB, and short-lived (deleted on a successful retry).
 */
export interface StoredPendingKeyBackup {
    sessionId: string;
    sessionKeyB64: string;
}

/**
 * An inbox archive whose every envelope is durably materialized in IndexedDB
 * (or is a non-message). Its presence here means the next sync may skip
 * downloading + decrypting that archive entirely. Keyed by the full S3 key,
 * which already contains the `{uid}` segment — no userId namespacing needed.
 */
export interface StoredIngestedArchive {
    key: string; // full S3 key, e.g. "inbox/U1/archive/2026-06-14-01HW…"
    ingestedAt: number; // ms epoch — for optional pruning, not correctness
}

/**
 * A decrypted media blob cached for offline browsing (ADR-0022 §7). Keyed by
 * the S3 URL; media objects are write-once, so a cached entry is never stale —
 * no invalidation. Holds **previews**, **below-threshold smalls**, and
 * **receiver-derived thumbnails** only — never a full original (deferred v2).
 * Decrypted-at-rest is the same exposure class as the message text and Megolm
 * pickles already in IDB ([ADR-0001]); not a new trust boundary.
 */
export interface StoredMediaBlob {
    url: string; // S3 key — primary key
    bytes: ArrayBuffer; // decrypted plaintext
    mime: string; // sniffed inline MIME (or 'application/octet-stream')
    cachedAt: number; // ms epoch — for optional future LRU
}

function awaitTx(tx: IDBTransaction): Promise<void> {
    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error ?? new Error('tx aborted'));
    });
}

function awaitReq<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

let db: IDBDatabase | null = null;

async function openDB(): Promise<IDBDatabase> {
    if (db) return db;

    return new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
            db = request.result;
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            const database = (event.target as IDBOpenDBRequest).result;

            // Create keys store (for CryptoKey objects) if it doesn't exist
            if (!database.objectStoreNames.contains(KEYS_STORE)) {
                database.createObjectStore(KEYS_STORE);
            }

            // Create messages store if it doesn't exist
            if (!database.objectStoreNames.contains(MESSAGES_STORE)) {
                const messagesStore = database.createObjectStore(
                    MESSAGES_STORE,
                    {
                        keyPath: 'id',
                    },
                );

                // Index by userId to query messages for a specific user's inbox
                messagesStore.createIndex('userId', 'userId', {
                    unique: false,
                });

                // Index by timestamp for chronological sorting
                messagesStore.createIndex('timestamp', 'timestamp', {
                    unique: false,
                });

                // Compound index for userId + timestamp queries
                messagesStore.createIndex(
                    'userId_timestamp',
                    ['userId', 'timestamp'],
                    {
                        unique: false,
                    },
                );

                // Index for search (can add full-text search later)
                messagesStore.createIndex('fromUser', 'fromUser', {
                    unique: false,
                });
            }

            // v4: Conversation summaries + contacts cache
            if (!database.objectStoreNames.contains(CONVERSATIONS_STORE)) {
                const convStore = database.createObjectStore(
                    CONVERSATIONS_STORE,
                    { keyPath: 'conversationId' },
                );
                convStore.createIndex(
                    'lastMessageTimestamp',
                    'lastMessageTimestamp',
                    { unique: false },
                );
            }

            if (!database.objectStoreNames.contains(CONTACTS_STORE)) {
                database.createObjectStore(CONTACTS_STORE, {
                    keyPath: 'userId',
                });
            }

            // v3: Megolm session stores
            if (!database.objectStoreNames.contains(MEGOLM_OUTBOUND_STORE)) {
                database.createObjectStore(MEGOLM_OUTBOUND_STORE, {
                    keyPath: 'id',
                });
            }

            if (!database.objectStoreNames.contains(MEGOLM_INBOUND_STORE)) {
                database.createObjectStore(MEGOLM_INBOUND_STORE, {
                    keyPath: 'sessionId',
                });
            }

            if (!database.objectStoreNames.contains(MEGOLM_KEY_SHARES_STORE)) {
                database.createObjectStore(MEGOLM_KEY_SHARES_STORE, {
                    keyPath: ['sessionId', 'recipientUserId'],
                });
            }

            // v5: Sync cursors for incremental inbox fetching
            if (!database.objectStoreNames.contains(SYNC_CURSORS_STORE)) {
                database.createObjectStore(SYNC_CURSORS_STORE, {
                    keyPath: 'prefix',
                });
            }

            // v6: Per-(userId, key_version) memoized backup keys recovered
            // by walking keys/{uid}/key_chain.json (ADR-0012). The chain
            // walker populates this lazily; on a fresh install it's empty.
            if (!database.objectStoreNames.contains(BACKUP_KEYS_STORE)) {
                database.createObjectStore(BACKUP_KEYS_STORE);
            }

            // v7: Key backups that failed to upload, queued for retry on the
            // next sync (I10 — no silent backup loss).
            if (
                !database.objectStoreNames.contains(PENDING_KEY_BACKUPS_STORE)
            ) {
                database.createObjectStore(PENDING_KEY_BACKUPS_STORE, {
                    keyPath: 'sessionId',
                });
            }

            // v8: Inbox archives fully materialized in IDB — skip re-fetching
            // them on the next sync (archive-ingest cache). Empty after the
            // upgrade, so the first post-upgrade sync re-downloads the full
            // archive once to populate it.
            if (!database.objectStoreNames.contains(INGESTED_ARCHIVES_STORE)) {
                database.createObjectStore(INGESTED_ARCHIVES_STORE, {
                    keyPath: 'key',
                });
            }

            // v9: Decrypted media blobs cached for offline browsing (ADR-0022
            // §7), keyed by S3 URL. Empty after the upgrade — the first view of
            // each media object fetches + decrypts once to populate it.
            if (!database.objectStoreNames.contains(MEDIA_CACHE_STORE)) {
                database.createObjectStore(MEDIA_CACHE_STORE, {
                    keyPath: 'url',
                });
            }
        };
    });
}

// ── CryptoKey storage ───────────────────────────────────────────────

export async function putKey(name: string, key: CryptoKey): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(KEYS_STORE, 'readwrite');
    tx.objectStore(KEYS_STORE).put(key, name);
    return awaitTx(tx);
}

export async function getKey(name: string): Promise<CryptoKey | undefined> {
    const database = await openDB();
    const tx = database.transaction(KEYS_STORE, 'readonly');
    return awaitReq<CryptoKey | undefined>(
        tx.objectStore(KEYS_STORE).get(name),
    );
}

export async function clearKeys(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(KEYS_STORE, 'readwrite');
    tx.objectStore(KEYS_STORE).clear();
    return awaitTx(tx);
}

// ── Backup keys by version (ADR-0012 chain memo) ───────────────────

export async function putBackupKey(
    userId: string,
    version: number,
    key: CryptoKey,
): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(BACKUP_KEYS_STORE, 'readwrite');
    tx.objectStore(BACKUP_KEYS_STORE).put(key, [userId, version]);
    return awaitTx(tx);
}

export async function getBackupKey(
    userId: string,
    version: number,
): Promise<CryptoKey | undefined> {
    const database = await openDB();
    const tx = database.transaction(BACKUP_KEYS_STORE, 'readonly');
    return awaitReq<CryptoKey | undefined>(
        tx.objectStore(BACKUP_KEYS_STORE).get([userId, version]),
    );
}

export async function clearBackupKeys(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(BACKUP_KEYS_STORE, 'readwrite');
    tx.objectStore(BACKUP_KEYS_STORE).clear();
    return awaitTx(tx);
}

// ── Pending key backups (I10 retry queue) ──────────────────────────

/** Queue a session key whose backup upload failed, for retry on next sync. */
export async function enqueuePendingKeyBackup(
    rec: StoredPendingKeyBackup,
): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(PENDING_KEY_BACKUPS_STORE, 'readwrite');
    tx.objectStore(PENDING_KEY_BACKUPS_STORE).put(rec);
    return awaitTx(tx);
}

/** All queued key backups awaiting a retry. */
export async function listPendingKeyBackups(): Promise<
    StoredPendingKeyBackup[]
> {
    const database = await openDB();
    const tx = database.transaction(PENDING_KEY_BACKUPS_STORE, 'readonly');
    return awaitReq<StoredPendingKeyBackup[]>(
        tx.objectStore(PENDING_KEY_BACKUPS_STORE).getAll(),
    );
}

/** Drop a queued backup once its retry succeeds. */
export async function deletePendingKeyBackup(sessionId: string): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(PENDING_KEY_BACKUPS_STORE, 'readwrite');
    tx.objectStore(PENDING_KEY_BACKUPS_STORE).delete(sessionId);
    return awaitTx(tx);
}

/** Drop the whole retry queue (tests). */
export async function clearPendingKeyBackups(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(PENDING_KEY_BACKUPS_STORE, 'readwrite');
    tx.objectStore(PENDING_KEY_BACKUPS_STORE).clear();
    return awaitTx(tx);
}

export function deleteDatabase(): Promise<void> {
    if (db) {
        db.close();
        db = null;
    }
    const request = indexedDB.deleteDatabase(DB_NAME);
    // Fires when another connection (another tab, or a React component
    // that reopened via getDB() before fully unmounting) is still open.
    // The deletion will proceed once that connection closes, but without
    // this handler the promise can hang silently. Log and keep waiting.
    request.onblocked = () => {
        console.warn(
            'deleteDatabase: blocked by another open connection; waiting',
        );
    };
    return awaitReq(request as unknown as IDBRequest<void>);
}

// ── Message storage ─────────────────────────────────────────────────

/**
 * Recompute a conversation's preview + sort timestamp from its full message
 * history, applying edit/delete amendments the same way the chat materializer
 * does (ADR-0014, `toMessages` in hooks/useChat). Returns the materialized
 * latest *surviving* message's stored plaintext and timestamp.
 *
 * The summary tracks the latest surviving message, not the latest amendment, so
 * this never advances the sort timestamp past an existing message: amending an
 * *older* message yields the same summary the conversation already had (caller
 * skips the write, no reorder), while deleting the latest message falls the
 * preview back to the previous survivor and editing it updates the preview text
 * in place. Returns null when the conversation has no originals at all (orphan
 * amendments only). When every original is deleted, returns an empty preview but
 * keeps the latest original's timestamp so the row holds its place.
 */
function summarizeConversation(
    msgs: StoredMessage[],
): { lastMessageText: string; lastMessageTimestamp: number } | null {
    const amendmentsByTarget = new Map<string, StoredMessage[]>();
    const originals: StoredMessage[] = [];
    for (const m of msgs) {
        const p = parseInner(m.text);
        if (p.kind === 'amendment') {
            const list = amendmentsByTarget.get(p.targetMsgId) ?? [];
            list.push(m);
            amendmentsByTarget.set(p.targetMsgId, list);
        } else if (p.kind !== 'unknown') {
            originals.push(m);
        }
    }
    if (originals.length === 0) return null;

    let best: { text: string; ts: number } | null = null;
    let latestTs = 0; // fallback position when every message is deleted
    for (const m of originals) {
        latestTs = Math.max(latestTs, m.timestamp);
        const orig = parseInner(m.text);
        let deleted = false;
        let editedBody: string | undefined;
        const chain = (amendmentsByTarget.get(m.id) ?? [])
            .slice()
            .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const am of chain) {
            const a = parseInner(am.text);
            if (a.kind !== 'amendment') continue;
            if (am.fromUser !== m.fromUser) continue; // authorization
            if (a.action === 'delete') {
                deleted = true;
                break; // terminal — delete trumps later amendments
            }
            // Edits only move a text message's preview; a media message's
            // preview stays its <photo>/<file> placeholder (caption-agnostic).
            if (
                a.action === 'edit' &&
                a.body !== undefined &&
                orig.kind === 'text'
            ) {
                editedBody = a.body; // last edit in the chain wins
            }
        }
        if (deleted) continue;
        const text =
            editedBody !== undefined
                ? JSON.stringify({ type: 'text', body: editedBody })
                : m.text;
        if (!best || m.timestamp > best.ts) best = { text, ts: m.timestamp };
    }

    return best
        ? { lastMessageText: best.text, lastMessageTimestamp: best.ts }
        : { lastMessageText: '', lastMessageTimestamp: latestTs };
}

/**
 * After a batch of amendments lands, recompute the summary of each affected
 * conversation so a deleted/edited *latest* message no longer shows stale
 * preview text in the chat list. Runs only on the amendment path, so normal
 * sends/receives keep their cheap additive summary update. messageCount is
 * carried through unchanged (amendments never change the count).
 */
async function recomputeAmendedSummaries(
    database: IDBDatabase,
    userId: string,
    convIds: Set<string>,
): Promise<void> {
    // Read all of the user's messages once + the current summaries (readonly).
    const txR = database.transaction(
        [MESSAGES_STORE, CONVERSATIONS_STORE],
        'readonly',
    );
    const allMsgs = await awaitReq<StoredMessage[]>(
        txR
            .objectStore(MESSAGES_STORE)
            .index('userId')
            .getAll(IDBKeyRange.only(userId)),
    );
    const currentByID = new Map<string, StoredConversation>();
    for (const convId of convIds) {
        const c = await awaitReq<StoredConversation | undefined>(
            txR.objectStore(CONVERSATIONS_STORE).get(convId),
        );
        if (c) currentByID.set(convId, c);
    }
    await awaitTx(txR);

    const byConv = new Map<string, StoredMessage[]>();
    for (const m of allMsgs) {
        if (!convIds.has(m.conversationId)) continue;
        const list = byConv.get(m.conversationId) ?? [];
        list.push(m);
        byConv.set(m.conversationId, list);
    }

    const writes: StoredConversation[] = [];
    for (const convId of convIds) {
        const current = currentByID.get(convId);
        if (!current) continue; // no summary yet → nothing to correct
        const summary = summarizeConversation(byConv.get(convId) ?? []);
        if (!summary) continue; // no originals → leave the summary untouched
        if (
            summary.lastMessageText === current.lastMessageText &&
            summary.lastMessageTimestamp === current.lastMessageTimestamp
        ) {
            continue; // amended an older message → no change, no reorder
        }
        writes.push({
            conversationId: convId,
            lastMessageText: summary.lastMessageText,
            lastMessageTimestamp: summary.lastMessageTimestamp,
            messageCount: current.messageCount,
        });
    }
    if (writes.length === 0) return;

    const txW = database.transaction(CONVERSATIONS_STORE, 'readwrite');
    const store = txW.objectStore(CONVERSATIONS_STORE);
    for (const w of writes) store.put(w);
    return awaitTx(txW);
}

export async function saveMessages(
    userId: string,
    messages: Array<{
        id: string;
        conversationId: string;
        fromUser: string;
        fromDevice: string;
        text: string;
        timestamp: Date;
    }>,
): Promise<void> {
    if (messages.length === 0) return;

    const database = await openDB();

    // Group messages by conversationId to build per-conversation summaries.
    const convUpdates = new Map<
        string,
        { text: string; ts: number; count: number }
    >();
    // Conversations that received an amendment in this batch — their latest
    // message may have changed (delete/edit), so their summary is recomputed
    // from full history after the writes land (see recomputeAmendedSummaries).
    const amendedConvs = new Set<string>();

    for (const msg of messages) {
        // Amendments (edit/delete) are stored, but must not bump a
        // conversation's timestamp/count — amending an old message should not
        // reorder the chat list. They are still written below, and the affected
        // conversation's preview is reconciled in the recompute pass.
        if (isAmendment(msg.text)) {
            amendedConvs.add(msg.conversationId);
            continue;
        }
        const ts = msg.timestamp.getTime();
        const prev = convUpdates.get(msg.conversationId);
        if (!prev || ts > prev.ts) {
            convUpdates.set(msg.conversationId, {
                text: msg.text,
                ts,
                count: (prev?.count ?? 0) + 1,
            });
        } else {
            prev.count++;
        }
    }

    // Phase 1: read existing conversation summaries into memory.
    const tx1 = database.transaction(CONVERSATIONS_STORE, 'readonly');
    const existingByID = new Map<string, StoredConversation>();
    for (const convId of convUpdates.keys()) {
        const existing = await awaitReq<StoredConversation | undefined>(
            tx1.objectStore(CONVERSATIONS_STORE).get(convId),
        );
        if (existing) existingByID.set(convId, existing);
    }
    await awaitTx(tx1);

    // Phase 2: write messages and updated summaries in a single synchronous
    // transaction — no callbacks or awaits between requests, so the tx stays
    // open until awaitTx resolves.
    const tx2 = database.transaction(
        [MESSAGES_STORE, CONVERSATIONS_STORE],
        'readwrite',
    );
    const msgStore = tx2.objectStore(MESSAGES_STORE);
    const convStore = tx2.objectStore(CONVERSATIONS_STORE);

    for (const msg of messages) {
        msgStore.put({
            id: msg.id,
            userId,
            conversationId: msg.conversationId,
            fromUser: msg.fromUser,
            fromDevice: msg.fromDevice,
            text: msg.text,
            timestamp: msg.timestamp.getTime(),
        } satisfies StoredMessage);
    }

    for (const [convId, update] of convUpdates) {
        const existing = existingByID.get(convId);
        convStore.put({
            conversationId: convId,
            lastMessageText:
                existing && existing.lastMessageTimestamp > update.ts
                    ? existing.lastMessageText
                    : update.text,
            lastMessageTimestamp: Math.max(
                existing?.lastMessageTimestamp ?? 0,
                update.ts,
            ),
            messageCount: (existing?.messageCount ?? 0) + update.count,
        } satisfies StoredConversation);
    }

    await awaitTx(tx2);

    // Reconcile conversations whose latest message was edited/deleted, so the
    // chat list never shows a deleted message as the last message.
    if (amendedConvs.size > 0) {
        await recomputeAmendedSummaries(database, userId, amendedConvs);
    }
}

export async function loadMessages(userId: string): Promise<StoredMessage[]> {
    const database = await openDB();
    const tx = database.transaction(MESSAGES_STORE, 'readonly');
    const index = tx.objectStore(MESSAGES_STORE).index('userId_timestamp');
    const range = IDBKeyRange.bound(
        [userId, 0],
        [userId, Number.MAX_SAFE_INTEGER],
    );
    return awaitReq<StoredMessage[]>(index.getAll(range));
}

/**
 * The set of msg_ids already stored for a user, read keys-only via the
 * `userId` index — does not deserialize message bodies. Used to seed the
 * sync dedup set so already-materialized messages are neither re-decrypted
 * nor counted as "missing" when their archive is (re-)downloaded.
 */
export async function loadMessageIds(userId: string): Promise<Set<string>> {
    const database = await openDB();
    const tx = database.transaction(MESSAGES_STORE, 'readonly');
    const index = tx.objectStore(MESSAGES_STORE).index('userId');
    const ids = await awaitReq<IDBValidKey[]>(
        index.getAllKeys(IDBKeyRange.only(userId)),
    );
    return new Set(ids as string[]);
}

export async function getLatestTimestamp(userId: string): Promise<number> {
    const database = await openDB();
    const tx = database.transaction(MESSAGES_STORE, 'readonly');
    const index = tx.objectStore(MESSAGES_STORE).index('userId_timestamp');
    const range = IDBKeyRange.bound(
        [userId, 0],
        [userId, Number.MAX_SAFE_INTEGER],
    );
    const cursor = await awaitReq<IDBCursorWithValue | null>(
        index.openCursor(range, 'prev'),
    );
    return cursor ? (cursor.value as StoredMessage).timestamp : 0;
}

export async function clearMessages(userId?: string): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MESSAGES_STORE, 'readwrite');
    const store = tx.objectStore(MESSAGES_STORE);

    if (userId) {
        // Clear only messages for this user
        const index = store.index('userId');
        const range = IDBKeyRange.only(userId);
        const request = index.openCursor(range);

        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                cursor.delete();
                cursor.continue();
            }
        };
    } else {
        // Clear all messages
        store.clear();
    }

    return awaitTx(tx);
}

// ── Conversations ────────────────────────────────────────────────

export async function loadConversations(): Promise<StoredConversation[]> {
    const database = await openDB();
    const tx = database.transaction(CONVERSATIONS_STORE, 'readonly');
    const index = tx
        .objectStore(CONVERSATIONS_STORE)
        .index('lastMessageTimestamp');
    const result = await awaitReq<StoredConversation[]>(index.getAll());
    // Index returns ascending; reverse for most-recent-first
    return result.reverse();
}

// ── Contacts ─────────────────────────────────────────────────────

export async function saveContact(
    userId: string,
    handle: string,
): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(CONTACTS_STORE, 'readwrite');
    tx.objectStore(CONTACTS_STORE).put({ userId, handle } as StoredContact);
    return awaitTx(tx);
}

export async function getContact(userId: string): Promise<string | null> {
    const database = await openDB();
    const tx = database.transaction(CONTACTS_STORE, 'readonly');
    const result = await awaitReq<StoredContact | undefined>(
        tx.objectStore(CONTACTS_STORE).get(userId),
    );
    return result?.handle ?? null;
}

export async function loadAllContacts(): Promise<Map<string, string>> {
    const database = await openDB();
    const tx = database.transaction(CONTACTS_STORE, 'readonly');
    const contacts = await awaitReq<StoredContact[]>(
        tx.objectStore(CONTACTS_STORE).getAll(),
    );
    const map = new Map<string, string>();
    for (const c of contacts) map.set(c.userId, c.handle);
    return map;
}

// ── Megolm outbound session ────────────────────────────────────────

export async function saveOutboundSession(
    sessionId: string,
    messageIndex: number,
    pickleJson: string,
): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_OUTBOUND_STORE, 'readwrite');
    const record: StoredOutboundSession = {
        id: 'current',
        pickleJson,
        sessionId,
        messageIndex,
    };
    tx.objectStore(MEGOLM_OUTBOUND_STORE).put(record);
    return awaitTx(tx);
}

export async function loadOutboundSession(): Promise<
    StoredOutboundSession | undefined
> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_OUTBOUND_STORE, 'readonly');
    return awaitReq<StoredOutboundSession | undefined>(
        tx.objectStore(MEGOLM_OUTBOUND_STORE).get('current'),
    );
}

export async function clearOutboundSession(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_OUTBOUND_STORE, 'readwrite');
    tx.objectStore(MEGOLM_OUTBOUND_STORE).clear();
    return awaitTx(tx);
}

// ── Megolm inbound sessions ───────────────────────────────────────

export async function saveInboundSession(
    sessionId: string,
    fromUser: string,
    fromDevice: string,
    pickleJson: string,
): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_INBOUND_STORE, 'readwrite');
    const record: StoredInboundSession = {
        sessionId,
        fromUser,
        fromDevice,
        pickleJson,
    };
    tx.objectStore(MEGOLM_INBOUND_STORE).put(record);
    return awaitTx(tx);
}

export async function loadInboundSession(
    sessionId: string,
): Promise<StoredInboundSession | undefined> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_INBOUND_STORE, 'readonly');
    return awaitReq<StoredInboundSession | undefined>(
        tx.objectStore(MEGOLM_INBOUND_STORE).get(sessionId),
    );
}

export async function clearInboundSessions(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_INBOUND_STORE, 'readwrite');
    tx.objectStore(MEGOLM_INBOUND_STORE).clear();
    return awaitTx(tx);
}

// ── Megolm key shares ─────────────────────────────────────────────

export async function recordKeyShare(
    sessionId: string,
    recipientUserId: string,
): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_KEY_SHARES_STORE, 'readwrite');
    const record: StoredKeyShare = {
        sessionId,
        recipientUserId,
        sharedAt: Date.now(),
    };
    tx.objectStore(MEGOLM_KEY_SHARES_STORE).put(record);
    return awaitTx(tx);
}

export async function hasKeyShare(
    sessionId: string,
    recipientUserId: string,
): Promise<boolean> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_KEY_SHARES_STORE, 'readonly');
    const result = await awaitReq(
        tx
            .objectStore(MEGOLM_KEY_SHARES_STORE)
            .get([sessionId, recipientUserId]),
    );
    return result !== undefined;
}

export async function clearKeyShares(sessionId?: string): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_KEY_SHARES_STORE, 'readwrite');
    const store = tx.objectStore(MEGOLM_KEY_SHARES_STORE);

    if (sessionId) {
        // Delete all shares for a specific session using cursor
        const request = store.openCursor();
        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                const record = cursor.value as StoredKeyShare;
                if (record.sessionId === sessionId) {
                    cursor.delete();
                }
                cursor.continue();
            }
        };
    } else {
        store.clear();
    }

    return awaitTx(tx);
}

// ── Sync cursors ──────────────────────────────────────────────────

export async function saveSyncCursor(
    prefix: string,
    cursor: string,
): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(SYNC_CURSORS_STORE, 'readwrite');
    tx.objectStore(SYNC_CURSORS_STORE).put({
        prefix,
        cursor,
    } as StoredSyncCursor);
    return awaitTx(tx);
}

export async function loadSyncCursor(
    prefix: string,
): Promise<string | undefined> {
    const database = await openDB();
    const tx = database.transaction(SYNC_CURSORS_STORE, 'readonly');
    const result = await awaitReq<StoredSyncCursor | undefined>(
        tx.objectStore(SYNC_CURSORS_STORE).get(prefix),
    );
    return result?.cursor;
}

export async function clearSyncCursors(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(SYNC_CURSORS_STORE, 'readwrite');
    tx.objectStore(SYNC_CURSORS_STORE).clear();
    return awaitTx(tx);
}

// ── Ingested archives (archive-ingest cache) ──────────────────────

/**
 * Mark an inbox archive as fully materialized. The caller must only invoke
 * this *after* the archive's messages are durably persisted (saveMessages),
 * and only when no envelope was skipped for a recoverable reason — otherwise
 * a not-yet-decryptable message would be lost forever to the skip.
 */
export async function markArchiveIngested(key: string): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(INGESTED_ARCHIVES_STORE, 'readwrite');
    tx.objectStore(INGESTED_ARCHIVES_STORE).put({
        key,
        ingestedAt: Date.now(),
    } satisfies StoredIngestedArchive);
    return awaitTx(tx);
}

/** Full S3 keys of every archive recorded as ingested. */
export async function loadIngestedArchiveKeys(): Promise<Set<string>> {
    const database = await openDB();
    const tx = database.transaction(INGESTED_ARCHIVES_STORE, 'readonly');
    const keys = await awaitReq<IDBValidKey[]>(
        tx.objectStore(INGESTED_ARCHIVES_STORE).getAllKeys(),
    );
    return new Set(keys as string[]);
}

export async function clearIngestedArchives(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(INGESTED_ARCHIVES_STORE, 'readwrite');
    tx.objectStore(INGESTED_ARCHIVES_STORE).clear();
    return awaitTx(tx);
}

// ── Media cache (ADR-0022 §7 — offline browsing) ──────────────────

/** The cached decrypted blob for an S3 URL, or undefined on a miss. */
export async function getMediaBlob(
    url: string,
): Promise<StoredMediaBlob | undefined> {
    const database = await openDB();
    const tx = database.transaction(MEDIA_CACHE_STORE, 'readonly');
    return awaitReq<StoredMediaBlob | undefined>(
        tx.objectStore(MEDIA_CACHE_STORE).get(url),
    );
}

/** Cache a decrypted blob (preview / below-threshold small / derived thumb). */
export async function putMediaBlob(entry: StoredMediaBlob): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEDIA_CACHE_STORE, 'readwrite');
    tx.objectStore(MEDIA_CACHE_STORE).put(entry);
    return awaitTx(tx);
}

/** Evict a cached blob (delete sweep, or a server 404). Best-effort. */
export async function deleteMediaBlob(url: string): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEDIA_CACHE_STORE, 'readwrite');
    tx.objectStore(MEDIA_CACHE_STORE).delete(url);
    return awaitTx(tx);
}

/** Drop the whole media cache (tests). */
export async function clearMediaCache(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEDIA_CACHE_STORE, 'readwrite');
    tx.objectStore(MEDIA_CACHE_STORE).clear();
    return awaitTx(tx);
}
