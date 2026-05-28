import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    clearInboundSessions,
    clearKeyShares,
    clearMessages,
    clearOutboundSession,
    clearSyncCursors,
    deleteDatabase,
    getContact,
    getLatestTimestamp,
    hasKeyShare,
    loadAllContacts,
    loadConversations,
    loadInboundSession,
    loadMessages,
    loadOutboundSession,
    loadSyncCursor,
    recordKeyShare,
    saveContact,
    saveInboundSession,
    saveMessages,
    saveOutboundSession,
    saveSyncCursor,
} from './db';

// Setup fake IndexedDB — fresh instance per test
beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = FakeIDBKeyRange;
});

// Reset module-level db cache so next test opens fresh
afterEach(async () => {
    await deleteDatabase();
});

describe('db - Message storage', () => {
    const testUserId = '01TEST123USER456';
    const convSelf = `self:${testUserId}`;
    const convOther = `dm:${testUserId}:other-user`;
    const testMessages: Array<{
        id: string;
        conversationId: string;
        fromUser: string;
        fromDevice: string;
        text: string;
        timestamp: Date;
    }> = [
        {
            id: 'msg-001',
            conversationId: convSelf,
            fromUser: testUserId,
            fromDevice: 'device-001',
            text: 'Hello world',
            timestamp: new Date('2024-01-01T10:00:00Z'),
        },
        {
            id: 'msg-002',
            conversationId: convSelf,
            fromUser: testUserId,
            fromDevice: 'device-001',
            text: 'Second message',
            timestamp: new Date('2024-01-01T11:00:00Z'),
        },
        {
            id: 'msg-003',
            conversationId: convOther,
            fromUser: 'other-user',
            fromDevice: 'device-002',
            text: 'Message from another user',
            timestamp: new Date('2024-01-01T12:00:00Z'),
        },
    ];

    describe('saveMessages', () => {
        it('saves messages to IndexedDB', async () => {
            await saveMessages(testUserId, testMessages);

            const loaded = await loadMessages(testUserId);
            expect(loaded).toHaveLength(3);
            expect(loaded[0]).toMatchObject({
                id: 'msg-001',
                userId: testUserId,
                fromUser: testUserId,
                text: 'Hello world',
                timestamp: new Date('2024-01-01T10:00:00Z').getTime(),
            });
        });

        it('overwrites existing messages with same id', async () => {
            await saveMessages(testUserId, [testMessages[0]]);

            const updated = [
                {
                    ...testMessages[0],
                    text: 'Updated text',
                },
            ];
            await saveMessages(testUserId, updated);

            const loaded = await loadMessages(testUserId);
            expect(loaded).toHaveLength(1);
            expect(loaded[0].text).toBe('Updated text');
        });
    });

    describe('loadMessages', () => {
        it('loads messages sorted by timestamp', async () => {
            const shuffled = [
                testMessages[2],
                testMessages[0],
                testMessages[1],
            ];
            await saveMessages(testUserId, shuffled);

            const loaded = await loadMessages(testUserId);
            expect(loaded).toHaveLength(3);
            expect(loaded[0].id).toBe('msg-001');
            expect(loaded[1].id).toBe('msg-002');
            expect(loaded[2].id).toBe('msg-003');
        });

        it('returns empty array when no messages exist', async () => {
            const loaded = await loadMessages('non-existent-user');
            expect(loaded).toEqual([]);
        });

        it('returns messages for specific user only', async () => {
            await saveMessages(testUserId, testMessages);
            await saveMessages('other-user-id', [
                {
                    id: 'msg-other',
                    conversationId: 'self:other-user-id',
                    fromUser: 'other-user-id',
                    fromDevice: 'device-other',
                    text: 'Other user message',
                    timestamp: new Date('2024-01-01T13:00:00Z'),
                },
            ]);

            const loaded = await loadMessages(testUserId);
            expect(loaded).toHaveLength(3);
            expect(loaded.every((m) => m.userId === testUserId)).toBe(true);
        });
    });

    describe('getLatestTimestamp', () => {
        it('returns timestamp of newest message', async () => {
            await saveMessages(testUserId, testMessages);

            const latest = await getLatestTimestamp(testUserId);
            expect(latest).toBe(new Date('2024-01-01T12:00:00Z').getTime());
        });

        it('returns 0 when no messages exist', async () => {
            const latest = await getLatestTimestamp('non-existent-user');
            expect(latest).toBe(0);
        });
    });

    describe('clearMessages', () => {
        it('clears all messages for a specific user', async () => {
            await saveMessages(testUserId, testMessages);
            await saveMessages('other-user', [
                {
                    id: 'msg-other',
                    conversationId: 'self:other-user',
                    fromUser: 'other-user',
                    fromDevice: 'device-other',
                    text: 'Other message',
                    timestamp: new Date('2024-01-01T13:00:00Z'),
                },
            ]);

            await clearMessages(testUserId);

            const loaded = await loadMessages(testUserId);
            expect(loaded).toEqual([]);

            const otherLoaded = await loadMessages('other-user');
            expect(otherLoaded).toHaveLength(1);
        });

        it('clears all messages when no userId specified', async () => {
            await saveMessages(testUserId, testMessages);
            await saveMessages('other-user', [
                {
                    id: 'msg-other',
                    conversationId: 'self:other-user',
                    fromUser: 'other-user',
                    fromDevice: 'device-other',
                    text: 'Other message',
                    timestamp: new Date('2024-01-01T13:00:00Z'),
                },
            ]);

            await clearMessages();

            const loaded1 = await loadMessages(testUserId);
            const loaded2 = await loadMessages('other-user');
            expect(loaded1).toEqual([]);
            expect(loaded2).toEqual([]);
        });
    });
});

describe('db - Conversations', () => {
    const userId = '01TEST123USER456';
    const convSelf = `self:${userId}`;
    const convDm = `dm:${userId}:other-user`;

    it('saveMessages upserts conversation summaries', async () => {
        await saveMessages(userId, [
            {
                id: 'msg-1',
                conversationId: convSelf,
                fromUser: userId,
                fromDevice: 'dev1',
                text: 'First saved',
                timestamp: new Date('2024-01-01T10:00:00Z'),
            },
            {
                id: 'msg-2',
                conversationId: convSelf,
                fromUser: userId,
                fromDevice: 'dev1',
                text: 'Second saved',
                timestamp: new Date('2024-01-01T11:00:00Z'),
            },
            {
                id: 'msg-3',
                conversationId: convDm,
                fromUser: 'other-user',
                fromDevice: 'dev2',
                text: 'Hello from other',
                timestamp: new Date('2024-01-01T12:00:00Z'),
            },
        ]);

        const convs = await loadConversations();
        expect(convs).toHaveLength(2);

        // Most recent first
        expect(convs[0].conversationId).toBe(convDm);
        expect(convs[0].lastMessageText).toBe('Hello from other');
        expect(convs[0].lastMessageTimestamp).toBe(
            new Date('2024-01-01T12:00:00Z').getTime(),
        );

        expect(convs[1].conversationId).toBe(convSelf);
        expect(convs[1].lastMessageText).toBe('Second saved');
    });

    it('upserts keep latest message across multiple saves', async () => {
        await saveMessages(userId, [
            {
                id: 'msg-1',
                conversationId: convDm,
                fromUser: 'other-user',
                fromDevice: 'dev2',
                text: 'Old message',
                timestamp: new Date('2024-01-01T10:00:00Z'),
            },
        ]);

        await saveMessages(userId, [
            {
                id: 'msg-2',
                conversationId: convDm,
                fromUser: 'other-user',
                fromDevice: 'dev2',
                text: 'New message',
                timestamp: new Date('2024-01-02T10:00:00Z'),
            },
        ]);

        const convs = await loadConversations();
        expect(convs).toHaveLength(1);
        expect(convs[0].lastMessageText).toBe('New message');
        expect(convs[0].lastMessageTimestamp).toBe(
            new Date('2024-01-02T10:00:00Z').getTime(),
        );
    });

    it('accumulates messageCount across successive saveMessages calls', async () => {
        await saveMessages(userId, [
            {
                id: 'msg-a1',
                conversationId: convDm,
                fromUser: 'other-user',
                fromDevice: 'dev2',
                text: 'first',
                timestamp: new Date('2024-01-01T10:00:00Z'),
            },
            {
                id: 'msg-a2',
                conversationId: convDm,
                fromUser: 'other-user',
                fromDevice: 'dev2',
                text: 'second',
                timestamp: new Date('2024-01-01T10:01:00Z'),
            },
        ]);

        await saveMessages(userId, [
            {
                id: 'msg-b1',
                conversationId: convDm,
                fromUser: 'other-user',
                fromDevice: 'dev2',
                text: 'third',
                timestamp: new Date('2024-01-01T10:02:00Z'),
            },
        ]);

        const convs = await loadConversations();
        expect(convs).toHaveLength(1);
        expect(convs[0].messageCount).toBe(3);
    });

    it('returns empty array when no conversations exist', async () => {
        const convs = await loadConversations();
        expect(convs).toEqual([]);
    });

    it('does not create conversations for empty message array', async () => {
        await saveMessages(userId, []);
        const convs = await loadConversations();
        expect(convs).toEqual([]);
    });
});

describe('db - Contacts', () => {
    it('saves and retrieves a contact', async () => {
        await saveContact('user-123', 'cool-handle');
        const handle = await getContact('user-123');
        expect(handle).toBe('cool-handle');
    });

    it('returns null for unknown userId', async () => {
        const handle = await getContact('unknown-user');
        expect(handle).toBeNull();
    });

    it('overwrites existing contact', async () => {
        await saveContact('user-123', 'old-handle');
        await saveContact('user-123', 'new-handle');
        const handle = await getContact('user-123');
        expect(handle).toBe('new-handle');
    });

    it('loadAllContacts returns all contacts as Map', async () => {
        await saveContact('user-1', 'handle-a');
        await saveContact('user-2', 'handle-b');

        const contacts = await loadAllContacts();
        expect(contacts.size).toBe(2);
        expect(contacts.get('user-1')).toBe('handle-a');
        expect(contacts.get('user-2')).toBe('handle-b');
    });

    it('loadAllContacts returns empty Map when none exist', async () => {
        const contacts = await loadAllContacts();
        expect(contacts.size).toBe(0);
    });
});

describe('db - Megolm outbound session', () => {
    it('saves and loads outbound session', async () => {
        await saveOutboundSession('S1', 5, '{"pickle":"data"}');

        const loaded = await loadOutboundSession();
        expect(loaded).toBeDefined();
        expect(loaded?.sessionId).toBe('S1');
        expect(loaded?.messageIndex).toBe(5);
        expect(loaded?.pickleJson).toBe('{"pickle":"data"}');
    });

    it('returns undefined when no session exists', async () => {
        const loaded = await loadOutboundSession();
        expect(loaded).toBeUndefined();
    });

    it('overwrites on save (single active session)', async () => {
        await saveOutboundSession('S1', 0, '{"v":1}');
        await saveOutboundSession('S2', 3, '{"v":2}');

        const loaded = await loadOutboundSession();
        expect(loaded?.sessionId).toBe('S2');
        expect(loaded?.messageIndex).toBe(3);
    });

    it('clears outbound session', async () => {
        await saveOutboundSession('S1', 0, '{}');
        await clearOutboundSession();

        const loaded = await loadOutboundSession();
        expect(loaded).toBeUndefined();
    });
});

describe('db - Megolm inbound sessions', () => {
    it('saves and loads by sessionId', async () => {
        await saveInboundSession('S1', 'bob01', 'bdev01', '{"pickle":"in"}');

        const loaded = await loadInboundSession('S1');
        expect(loaded).toBeDefined();
        expect(loaded?.sessionId).toBe('S1');
        expect(loaded?.fromUser).toBe('bob01');
        expect(loaded?.fromDevice).toBe('bdev01');
        expect(loaded?.pickleJson).toBe('{"pickle":"in"}');
    });

    it('returns undefined for unknown sessionId', async () => {
        const loaded = await loadInboundSession('unknown');
        expect(loaded).toBeUndefined();
    });

    it('stores multiple sessions independently', async () => {
        await saveInboundSession('S1', 'bob01', 'bdev01', '{"s":1}');
        await saveInboundSession('S2', 'alice01', 'adev01', '{"s":2}');

        const s1 = await loadInboundSession('S1');
        const s2 = await loadInboundSession('S2');
        expect(s1?.fromUser).toBe('bob01');
        expect(s2?.fromUser).toBe('alice01');
    });

    it('clears all inbound sessions', async () => {
        await saveInboundSession('S1', 'bob01', 'bdev01', '{}');
        await saveInboundSession('S2', 'alice01', 'adev01', '{}');
        await clearInboundSessions();

        expect(await loadInboundSession('S1')).toBeUndefined();
        expect(await loadInboundSession('S2')).toBeUndefined();
    });
});

describe('db - Megolm key shares', () => {
    it('records and checks key share', async () => {
        expect(await hasKeyShare('S1', 'bob01')).toBe(false);

        await recordKeyShare('S1', 'bob01');
        expect(await hasKeyShare('S1', 'bob01')).toBe(true);
    });

    it('tracks shares per session and recipient independently', async () => {
        await recordKeyShare('S1', 'bob01');

        expect(await hasKeyShare('S1', 'bob01')).toBe(true);
        expect(await hasKeyShare('S1', 'alice01')).toBe(false);
        expect(await hasKeyShare('S2', 'bob01')).toBe(false);
    });

    it('clears shares for a specific session', async () => {
        await recordKeyShare('S1', 'bob01');
        await recordKeyShare('S1', 'alice01');
        await recordKeyShare('S2', 'bob01');

        await clearKeyShares('S1');

        expect(await hasKeyShare('S1', 'bob01')).toBe(false);
        expect(await hasKeyShare('S1', 'alice01')).toBe(false);
        expect(await hasKeyShare('S2', 'bob01')).toBe(true);
    });

    it('clears all shares', async () => {
        await recordKeyShare('S1', 'bob01');
        await recordKeyShare('S2', 'alice01');

        await clearKeyShares();

        expect(await hasKeyShare('S1', 'bob01')).toBe(false);
        expect(await hasKeyShare('S2', 'alice01')).toBe(false);
    });
});

describe('db - Sync cursors', () => {
    it('saves and loads a cursor by prefix', async () => {
        await saveSyncCursor('inbox/user1/live/', 'inbox/user1/live/msg-050');

        const cursor = await loadSyncCursor('inbox/user1/live/');
        expect(cursor).toBe('inbox/user1/live/msg-050');
    });

    it('returns undefined for unknown prefix', async () => {
        const cursor = await loadSyncCursor('inbox/unknown/live/');
        expect(cursor).toBeUndefined();
    });

    it('overwrites cursor for same prefix', async () => {
        await saveSyncCursor('inbox/user1/live/', 'inbox/user1/live/msg-010');
        await saveSyncCursor('inbox/user1/live/', 'inbox/user1/live/msg-050');

        const cursor = await loadSyncCursor('inbox/user1/live/');
        expect(cursor).toBe('inbox/user1/live/msg-050');
    });

    it('stores cursors independently per prefix', async () => {
        await saveSyncCursor('inbox/user1/live/', 'inbox/user1/live/msg-010');
        await saveSyncCursor('inbox/user2/live/', 'inbox/user2/live/msg-020');

        expect(await loadSyncCursor('inbox/user1/live/')).toBe(
            'inbox/user1/live/msg-010',
        );
        expect(await loadSyncCursor('inbox/user2/live/')).toBe(
            'inbox/user2/live/msg-020',
        );
    });

    it('clears all cursors', async () => {
        await saveSyncCursor('inbox/user1/live/', 'inbox/user1/live/msg-010');
        await saveSyncCursor('inbox/user2/live/', 'inbox/user2/live/msg-020');

        await clearSyncCursors();

        expect(await loadSyncCursor('inbox/user1/live/')).toBeUndefined();
        expect(await loadSyncCursor('inbox/user2/live/')).toBeUndefined();
    });
});

// ── v6 migration (backup_keys_by_version) ────────────────────────────

describe('schema migration v5 → v6 (backup_keys_by_version)', () => {
    function openAt(version: number): Promise<IDBDatabase> {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('atmin', version);
            req.onerror = () => reject(req.error);
            req.onsuccess = () => resolve(req.result);
            req.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                if (!db.objectStoreNames.contains('keys')) {
                    db.createObjectStore('keys');
                }
                if (!db.objectStoreNames.contains('messages')) {
                    const s = db.createObjectStore('messages', {
                        keyPath: 'id',
                    });
                    s.createIndex('userId', 'userId');
                    s.createIndex('timestamp', 'timestamp');
                    s.createIndex('userId_timestamp', ['userId', 'timestamp']);
                    s.createIndex('fromUser', 'fromUser');
                }
                if (!db.objectStoreNames.contains('conversations')) {
                    const s = db.createObjectStore('conversations', {
                        keyPath: 'conversationId',
                    });
                    s.createIndex(
                        'lastMessageTimestamp',
                        'lastMessageTimestamp',
                    );
                }
                if (!db.objectStoreNames.contains('contacts')) {
                    db.createObjectStore('contacts', { keyPath: 'userId' });
                }
                if (!db.objectStoreNames.contains('megolm_outbound')) {
                    db.createObjectStore('megolm_outbound', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('megolm_inbound')) {
                    db.createObjectStore('megolm_inbound', {
                        keyPath: 'sessionId',
                    });
                }
                if (!db.objectStoreNames.contains('megolm_key_shares')) {
                    db.createObjectStore('megolm_key_shares', {
                        keyPath: ['sessionId', 'recipientUserId'],
                    });
                }
                if (!db.objectStoreNames.contains('sync_cursors')) {
                    db.createObjectStore('sync_cursors', { keyPath: 'prefix' });
                }
            };
        });
    }

    it('opening at v6 on top of a populated v5 DB preserves rows and adds backup_keys_by_version', async () => {
        const v5 = await openAt(5);
        const tx = v5.transaction(
            [
                'contacts',
                'megolm_outbound',
                'sync_cursors',
                'messages',
                'conversations',
                'megolm_inbound',
                'megolm_key_shares',
            ],
            'readwrite',
        );
        tx.objectStore('contacts').put({
            userId: 'U_BOB',
            handle: 'cool-badger',
        });
        tx.objectStore('megolm_outbound').put({
            id: 'current',
            pickleJson: '{}',
            sessionId: 'S1',
            messageIndex: 7,
        });
        tx.objectStore('sync_cursors').put({
            prefix: 'inbox/U/live/',
            cursor: 'X',
        });
        tx.objectStore('messages').put({
            id: 'M1',
            userId: 'U',
            conversationId: 'C',
            fromUser: 'A',
            fromDevice: 'D',
            text: 'hi',
            timestamp: 42,
        });
        tx.objectStore('conversations').put({
            conversationId: 'C',
            lastMessageText: 'hi',
            lastMessageTimestamp: 42,
            messageCount: 1,
        });
        tx.objectStore('megolm_inbound').put({
            sessionId: 'S1',
            fromUser: 'A',
            fromDevice: 'D',
            pickleJson: '{}',
        });
        tx.objectStore('megolm_key_shares').put({
            sessionId: 'S1',
            recipientUserId: 'B',
            sharedAt: 1,
        });
        await new Promise<void>((res, rej) => {
            tx.oncomplete = () => res();
            tx.onerror = () => rej(tx.error);
        });
        v5.close();

        // Trigger the v6 migration via the production open path.
        expect((await loadAllContacts()).get('U_BOB')).toBe('cool-badger');
        expect((await loadOutboundSession())?.sessionId).toBe('S1');
        expect(await loadSyncCursor('inbox/U/live/')).toBe('X');
        expect((await loadMessages('U'))[0]?.text).toBe('hi');
        expect((await loadConversations())[0]?.conversationId).toBe('C');
        expect((await loadInboundSession('S1'))?.pickleJson).toBe('{}');
        expect(await hasKeyShare('S1', 'B')).toBe(true);

        const { getBackupKey } = await import('./db');
        expect(await getBackupKey('U_BOB', 1)).toBeUndefined();
    });

    it('fresh install creates backup_keys_by_version and round-trips a key', async () => {
        await saveContact('U_X', 'h');
        expect(await getContact('U_X')).toBe('h');

        const { putBackupKey, getBackupKey } = await import('./db');
        const { deriveKeys, generateBackupSecret } = await import('./crypto');
        const key = (await deriveKeys(generateBackupSecret())).backupKey;
        await putBackupKey('U_X', 1, key);
        const got = await getBackupKey('U_X', 1);
        expect(got).toBeDefined();
        expect(got?.type).toBe('secret');
    });
});
