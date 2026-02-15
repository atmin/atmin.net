/**
 * IndexedDB storage for atmin.net
 * - 'keys' store: CryptoKey objects
 * - 'messages' store: Encrypted messages
 * - 'megolm_outbound' store: Active outbound Megolm session
 * - 'megolm_inbound' store: Inbound Megolm sessions (one per sender session)
 * - 'megolm_key_shares' store: Track which recipients have the session key
 */

const DB_NAME = 'atmin';
const DB_VERSION = 3;
const KEYS_STORE = 'keys';
const MESSAGES_STORE = 'messages';
const MEGOLM_OUTBOUND_STORE = 'megolm_outbound';
const MEGOLM_INBOUND_STORE = 'megolm_inbound';
const MEGOLM_KEY_SHARES_STORE = 'megolm_key_shares';

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
    fromUser: string;
    fromDevice: string;
    text: string;
    timestamp: number; // milliseconds since epoch
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
        };
    });
}

// ── CryptoKey storage ───────────────────────────────────────────────

export async function putKey(name: string, key: CryptoKey): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(KEYS_STORE, 'readwrite');
    tx.objectStore(KEYS_STORE).put(key, name);

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function getKey(name: string): Promise<CryptoKey | undefined> {
    const database = await openDB();
    const tx = database.transaction(KEYS_STORE, 'readonly');
    const request = tx.objectStore(KEYS_STORE).get(name);

    return new Promise((resolve, reject) => {
        request.onsuccess = () =>
            resolve(request.result as CryptoKey | undefined);
        request.onerror = () => reject(request.error);
    });
}

export async function clearKeys(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(KEYS_STORE, 'readwrite');
    tx.objectStore(KEYS_STORE).clear();

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

// ── Message storage ─────────────────────────────────────────────────

export async function saveMessages(
    userId: string,
    messages: Array<{
        id: string;
        fromUser: string;
        fromDevice: string;
        text: string;
        timestamp: Date;
    }>,
): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MESSAGES_STORE, 'readwrite');
    const store = tx.objectStore(MESSAGES_STORE);

    for (const msg of messages) {
        const stored: StoredMessage = {
            id: msg.id,
            userId,
            fromUser: msg.fromUser,
            fromDevice: msg.fromDevice,
            text: msg.text,
            timestamp: msg.timestamp.getTime(),
        };
        store.put(stored);
    }

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadMessages(userId: string): Promise<StoredMessage[]> {
    const database = await openDB();
    const tx = database.transaction(MESSAGES_STORE, 'readonly');
    const store = tx.objectStore(MESSAGES_STORE);
    const index = store.index('userId_timestamp');

    // Get all messages for this user, sorted by timestamp
    const range = IDBKeyRange.bound(
        [userId, 0],
        [userId, Number.MAX_SAFE_INTEGER],
    );

    return new Promise((resolve, reject) => {
        const request = index.getAll(range);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

export async function getLatestTimestamp(userId: string): Promise<number> {
    const database = await openDB();
    const tx = database.transaction(MESSAGES_STORE, 'readonly');
    const store = tx.objectStore(MESSAGES_STORE);
    const index = store.index('userId_timestamp');

    // Get messages in reverse order (latest first)
    const range = IDBKeyRange.bound(
        [userId, 0],
        [userId, Number.MAX_SAFE_INTEGER],
    );

    return new Promise((resolve, reject) => {
        const request = index.openCursor(range, 'prev');
        request.onsuccess = () => {
            const cursor = request.result;
            if (cursor) {
                resolve((cursor.value as StoredMessage).timestamp);
            } else {
                resolve(0); // No messages yet
            }
        };
        request.onerror = () => reject(request.error);
    });
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

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
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

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadOutboundSession(): Promise<
    StoredOutboundSession | undefined
> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_OUTBOUND_STORE, 'readonly');
    const request = tx.objectStore(MEGOLM_OUTBOUND_STORE).get('current');

    return new Promise((resolve, reject) => {
        request.onsuccess = () =>
            resolve(request.result as StoredOutboundSession | undefined);
        request.onerror = () => reject(request.error);
    });
}

export async function clearOutboundSession(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_OUTBOUND_STORE, 'readwrite');
    tx.objectStore(MEGOLM_OUTBOUND_STORE).clear();

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
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

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function loadInboundSession(
    sessionId: string,
): Promise<StoredInboundSession | undefined> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_INBOUND_STORE, 'readonly');
    const request = tx.objectStore(MEGOLM_INBOUND_STORE).get(sessionId);

    return new Promise((resolve, reject) => {
        request.onsuccess = () =>
            resolve(request.result as StoredInboundSession | undefined);
        request.onerror = () => reject(request.error);
    });
}

export async function clearInboundSessions(): Promise<void> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_INBOUND_STORE, 'readwrite');
    tx.objectStore(MEGOLM_INBOUND_STORE).clear();

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
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

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

export async function hasKeyShare(
    sessionId: string,
    recipientUserId: string,
): Promise<boolean> {
    const database = await openDB();
    const tx = database.transaction(MEGOLM_KEY_SHARES_STORE, 'readonly');
    const request = tx
        .objectStore(MEGOLM_KEY_SHARES_STORE)
        .get([sessionId, recipientUserId]);

    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result !== undefined);
        request.onerror = () => reject(request.error);
    });
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

    return new Promise((resolve, reject) => {
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}
