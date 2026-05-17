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
 */

const DB_NAME = 'atmin';
const DB_VERSION = 5;
const KEYS_STORE = 'keys';
const MESSAGES_STORE = 'messages';
const CONVERSATIONS_STORE = 'conversations';
const CONTACTS_STORE = 'contacts';
const MEGOLM_OUTBOUND_STORE = 'megolm_outbound';
const MEGOLM_INBOUND_STORE = 'megolm_inbound';
const MEGOLM_KEY_SHARES_STORE = 'megolm_key_shares';
const SYNC_CURSORS_STORE = 'sync_cursors';

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
    const tx = database.transaction(
        [MESSAGES_STORE, CONVERSATIONS_STORE],
        'readwrite',
    );
    const msgStore = tx.objectStore(MESSAGES_STORE);
    const convStore = tx.objectStore(CONVERSATIONS_STORE);

    // Group messages by conversationId to build summaries
    const convUpdates = new Map<
        string,
        { text: string; ts: number; count: number }
    >();

    for (const msg of messages) {
        const ts = msg.timestamp.getTime();
        const stored: StoredMessage = {
            id: msg.id,
            userId,
            conversationId: msg.conversationId,
            fromUser: msg.fromUser,
            fromDevice: msg.fromDevice,
            text: msg.text,
            timestamp: ts,
        };
        msgStore.put(stored);

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

    // Upsert conversation summaries (read-modify-write inside an open tx).
    // IDB autocommits when the microtask queue drains, so queuing a put()
    // inside getReq.onsuccess keeps everything on the same transaction.
    for (const [convId, update] of convUpdates) {
        const getReq = convStore.get(convId);
        getReq.onsuccess = () => {
            const existing = getReq.result as StoredConversation | undefined;
            const conv: StoredConversation = {
                conversationId: convId,
                lastMessageText:
                    existing && existing.lastMessageTimestamp > update.ts
                        ? existing.lastMessageText
                        : update.text,
                lastMessageTimestamp: Math.max(
                    existing?.lastMessageTimestamp ?? 0,
                    update.ts,
                ),
                messageCount: Math.max(
                    existing?.messageCount ?? 0,
                    update.count,
                ),
            };
            convStore.put(conv);
        };
    }

    return awaitTx(tx);
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
