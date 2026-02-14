/**
 * IndexedDB storage for atmin.net
 * - 'keys' store: CryptoKey objects
 * - 'messages' store: Encrypted messages
 */

const DB_NAME = 'atmin';
const DB_VERSION = 2;
const KEYS_STORE = 'keys';
const MESSAGES_STORE = 'messages';

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
