import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    clearInboundSessions,
    clearKeyShares,
    clearMessages,
    clearOutboundSession,
    getLatestTimestamp,
    hasKeyShare,
    loadInboundSession,
    loadMessages,
    loadOutboundSession,
    recordKeyShare,
    saveInboundSession,
    saveMessages,
    saveOutboundSession,
} from './db';

// Setup fake IndexedDB
beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = FakeIDBKeyRange;
});

// Clear database after each test
afterEach(async () => {
    await clearMessages();
    await clearOutboundSession();
    await clearInboundSessions();
    await clearKeyShares();
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
