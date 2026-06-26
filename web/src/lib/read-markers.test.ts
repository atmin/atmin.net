import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    type Mock,
    vi,
} from 'vitest';
import { installFetchMock, stored, uninstallFetchMock } from './api.mock';
import type { Session } from './auth';
import { deriveKeys, generateBackupSecret } from './crypto';
import {
    deleteDatabase,
    getConversationLastRead,
    markConversationRead,
    saveMessages,
    unreadCounts,
} from './db';
import { mergeMarkers } from './read-markers';

vi.mock('./api', async () => {
    const { makeApiMock } = await import('./api.mock');
    return makeApiMock();
});

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = FakeIDBKeyRange;
    stored.clear();
    installFetchMock();
});

afterEach(async () => {
    const { _resetReadMarkers } = await import('./read-markers');
    _resetReadMarkers();
    await deleteDatabase();
    uninstallFetchMock();
});

// ── The CRDT join ────────────────────────────────────────────────

describe('mergeMarkers', () => {
    it('takes the per-conversation max', () => {
        expect(mergeMarkers({ a: 5, b: 1 }, { a: 3, b: 9 })).toEqual({
            a: 5,
            b: 9,
        });
    });

    it('unions keys present on only one side', () => {
        expect(mergeMarkers({ a: 5 }, { b: 9 })).toEqual({ a: 5, b: 9 });
    });

    it('is commutative', () => {
        const x = { a: 5, b: 1, c: 7 };
        const y = { a: 3, b: 9, d: 2 };
        expect(mergeMarkers(x, y)).toEqual(mergeMarkers(y, x));
    });

    it('is idempotent — merging a value with itself is a no-op', () => {
        const x = { a: 5, b: 9 };
        expect(mergeMarkers(x, x)).toEqual(x);
        expect(mergeMarkers(mergeMarkers(x, x), x)).toEqual(x);
    });

    it('converges regardless of association order', () => {
        const a = { conv: 1 };
        const b = { conv: 5 };
        const c = { conv: 3 };
        const left = mergeMarkers(mergeMarkers(a, b), c);
        const right = mergeMarkers(a, mergeMarkers(b, c));
        expect(left).toEqual(right);
        expect(left).toEqual({ conv: 5 });
    });

    it('does not mutate its inputs', () => {
        const a = { conv: 1 };
        const b = { conv: 5 };
        mergeMarkers(a, b);
        expect(a).toEqual({ conv: 1 });
        expect(b).toEqual({ conv: 5 });
    });
});

// ── Blob round-trip + cross-device convergence ───────────────────

describe('read-markers blob', () => {
    const token = 'test-token';
    const userId = 'U_ALICE';
    const conv = `dm:${userId}:U_BOB`;

    async function makeBackupKey(extractable = false) {
        return (await deriveKeys(generateBackupSecret(), { extractable }))
            .backupKey;
    }

    function makeSession(backupKey: CryptoKey, keyVersion: number): Session {
        return { token, userId, backupKey, keyVersion } as unknown as Session;
    }

    // Two incoming + one own message; incoming at ts 1000 and 2000.
    async function seedConversation() {
        await saveMessages(userId, [
            {
                id: 'm1',
                conversationId: conv,
                fromUser: 'U_BOB',
                fromDevice: 'D',
                text: 'one',
                timestamp: new Date(1000),
            },
            {
                id: 'm2',
                conversationId: conv,
                fromUser: 'U_BOB',
                fromDevice: 'D',
                text: 'two',
                timestamp: new Date(2000),
            },
            {
                id: 'm3',
                conversationId: conv,
                fromUser: userId,
                fromDevice: 'D',
                text: 'mine',
                timestamp: new Date(3000),
            },
        ]);
    }

    it('round-trips markers through upload → fetch', async () => {
        const backupKey = await makeBackupKey();
        const { uploadReadMarkers, fetchReadMarkers } = await import(
            './read-markers'
        );

        await uploadReadMarkers(token, userId, backupKey, 1, { [conv]: 2000 });
        expect(stored.has(`users/${userId}/read-markers.json`)).toBe(true);

        expect(await fetchReadMarkers(token, userId, backupKey, 1)).toEqual({
            [conv]: 2000,
        });
    });

    it('fetch returns {} when the blob does not exist', async () => {
        const backupKey = await makeBackupKey();
        const { fetchReadMarkers } = await import('./read-markers');
        expect(await fetchReadMarkers(token, userId, backupKey, 1)).toEqual({});
    });

    it('syncReadMarkers uploads when local is ahead of remote', async () => {
        const backupKey = await makeBackupKey();
        const session = makeSession(backupKey, 1);
        const { syncReadMarkers, fetchReadMarkers } = await import(
            './read-markers'
        );

        await seedConversation();
        await markConversationRead(conv, 3000);

        await syncReadMarkers(session);
        expect(await fetchReadMarkers(token, userId, backupKey, 1)).toEqual({
            [conv]: 3000,
        });
    });

    it('a chat read on device A clears unread on device B after sync', async () => {
        const backupKey = await makeBackupKey();
        const session = makeSession(backupKey, 1);
        const { syncReadMarkers } = await import('./read-markers');

        // Device A reads the whole conversation and pushes the marker.
        await seedConversation();
        await markConversationRead(conv, 3000);
        await syncReadMarkers(session);

        // Device B: fresh DB with the same synced messages, nothing read yet —
        // every incoming message currently reads as "new".
        await deleteDatabase();
        globalThis.indexedDB = new IDBFactory();
        await seedConversation();
        expect(await unreadCounts(userId)).toEqual(new Map([[conv, 2]]));

        // B syncs → A's read marker merges in → no fake "new".
        expect(await syncReadMarkers(session)).toBe(true);
        expect(await unreadCounts(userId)).toEqual(new Map());
        expect(await getConversationLastRead(conv)).toBe(3000);
    });

    it('syncReadMarkers is idempotent — a second sync changes nothing', async () => {
        const backupKey = await makeBackupKey();
        const session = makeSession(backupKey, 1);
        const { syncReadMarkers } = await import('./read-markers');

        await seedConversation();
        await markConversationRead(conv, 3000);
        await syncReadMarkers(session);

        // Already converged: nothing advances locally on a repeat sync.
        expect(await syncReadMarkers(session)).toBe(false);
        expect(await getConversationLastRead(conv)).toBe(3000);
    });

    it('walks the key chain to decrypt a v1 blob under a v2 account', async () => {
        const { uploadReadMarkers, fetchReadMarkers } = await import(
            './read-markers'
        );
        const { buildChainLink, appendChainLink } = await import('./key-chain');

        const v1Key = await makeBackupKey(true);
        const v2Key = await makeBackupKey(true);

        await uploadReadMarkers(token, userId, v1Key, 1, { [conv]: 2000 });
        await appendChainLink(
            token,
            userId,
            await buildChainLink(1, 2, v1Key, v2Key),
        );

        // Fresh device at v2 must walk the chain back to v1 to decrypt.
        await deleteDatabase();
        globalThis.indexedDB = new IDBFactory();
        expect(await fetchReadMarkers(token, userId, v2Key, 2)).toEqual({
            [conv]: 2000,
        });
    });

    it('skips a blob written under a newer key version than current', async () => {
        const { uploadReadMarkers, fetchReadMarkers } = await import(
            './read-markers'
        );
        const v1Key = await makeBackupKey(true);
        const v2Key = await makeBackupKey(true);

        await uploadReadMarkers(token, userId, v2Key, 2, { [conv]: 2000 });
        // Reading at currentVersion=1 can't open a v2 blob → {}.
        expect(await fetchReadMarkers(token, userId, v1Key, 1)).toEqual({});
    });

    it('scheduleReadMarkerPush coalesces rapid calls into a single push', async () => {
        const backupKey = await makeBackupKey();
        const session = makeSession(backupKey, 1);
        const { scheduleReadMarkerPush } = await import('./read-markers');
        const { storePresign } = await import('./api');

        await seedConversation();
        await markConversationRead(conv, 3000);

        const key = `users/${userId}/read-markers.json`;
        const presignsForKey = () =>
            (storePresign as Mock).mock.calls.filter((c) => c[1] === key)
                .length;
        const before = presignsForKey(); // mock history accumulates across tests

        // Three rapid schedules collapse onto one debounced timer.
        scheduleReadMarkerPush(session, 10);
        scheduleReadMarkerPush(session, 10);
        scheduleReadMarkerPush(session, 10);
        await new Promise((r) => setTimeout(r, 60));

        expect(stored.has(key)).toBe(true);
        expect(presignsForKey() - before).toBe(1);
    });
});
