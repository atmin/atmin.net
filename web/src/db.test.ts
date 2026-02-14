import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    clearMessages,
    getLatestTimestamp,
    loadMessages,
    saveMessages,
} from './db';

// Setup fake IndexedDB
beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = FakeIDBKeyRange;
});

// Clear database after each test
afterEach(async () => {
    await clearMessages();
});

describe('db - Message storage', () => {
    const testUserId = '01TEST123USER456';
    const testMessages: Array<{
        id: string;
        fromUser: string;
        fromDevice: string;
        text: string;
        timestamp: Date;
    }> = [
        {
            id: 'msg-001',
            fromUser: testUserId,
            fromDevice: 'device-001',
            text: 'Hello world',
            timestamp: new Date('2024-01-01T10:00:00Z'),
        },
        {
            id: 'msg-002',
            fromUser: testUserId,
            fromDevice: 'device-001',
            text: 'Second message',
            timestamp: new Date('2024-01-01T11:00:00Z'),
        },
        {
            id: 'msg-003',
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
