import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./messaging', () => ({
    syncMessages: vi.fn(),
}));
vi.mock('./db', () => ({
    saveMessages: vi.fn(),
    markArchiveIngested: vi.fn(),
}));

import { markArchiveIngested, saveMessages } from './db';
import {
    _resetInboxListeners,
    onInboxUpdated,
    syncAndPublish,
} from './inbox-sync';
import { syncMessages } from './messaging';

const syncMessagesMock = vi.mocked(syncMessages);
const saveMessagesMock = vi.mocked(saveMessages);
const markArchiveIngestedMock = vi.mocked(markArchiveIngested);

// Build the SyncResult shape syncMessages now resolves to.
function syncResult(
    messages: Awaited<ReturnType<typeof syncMessages>>['messages'] = [],
    ingestedCandidates: string[] = [],
) {
    return { messages, ingestedCandidates };
}

// Minimal Session stub; only fields syncAndPublish forwards into syncMessages.
const fakeSession = {
    token: 't',
    userId: 'u',
    deviceId: 'd',
    handle: 'h',
    sharingPrivateKey: 'pk' as unknown as CryptoKey,
    sharingPublicKeyBytes: new Uint8Array(),
    backupKey: 'bk' as unknown as CryptoKey,
    keyVersion: 1,
};
const fakeSessionManager = {} as Parameters<typeof syncAndPublish>[1];

beforeEach(() => {
    _resetInboxListeners();
    syncMessagesMock.mockReset();
    saveMessagesMock.mockReset();
    markArchiveIngestedMock.mockReset();
    markArchiveIngestedMock.mockResolvedValue(undefined);
});
afterEach(() => {
    _resetInboxListeners();
});

describe('syncAndPublish', () => {
    it('calls syncMessages with the session fields, saves, and notifies', async () => {
        const msg = {
            id: 'm1',
            conversationId: 'dm:a:b',
            fromUser: 'a',
            fromDevice: 'd',
            text: 'hi',
            timestamp: new Date(0),
        };
        syncMessagesMock.mockResolvedValue(syncResult([msg]));
        saveMessagesMock.mockResolvedValue(undefined);

        const listener = vi.fn();
        onInboxUpdated(listener);

        await syncAndPublish(fakeSession, fakeSessionManager);

        expect(syncMessagesMock).toHaveBeenCalledWith(
            't',
            'u',
            fakeSession.sharingPrivateKey,
            fakeSessionManager,
            fakeSession.backupKey,
            fakeSession.keyVersion,
        );
        expect(saveMessagesMock).toHaveBeenCalledWith('u', [msg]);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('marks ingested candidates after messages are persisted', async () => {
        const msg = {
            id: 'm1',
            conversationId: 'dm:a:b',
            fromUser: 'a',
            fromDevice: 'd',
            text: 'hi',
            timestamp: new Date(0),
        };
        const k1 = 'inbox/u/archive/2025-01-10-01A';
        const k2 = 'inbox/u/archive/2025-01-15-01B';
        syncMessagesMock.mockResolvedValue(syncResult([msg], [k1, k2]));

        const order: string[] = [];
        saveMessagesMock.mockImplementation(async () => {
            order.push('save');
        });
        markArchiveIngestedMock.mockImplementation(async (key: string) => {
            order.push(`mark:${key}`);
        });

        await syncAndPublish(fakeSession, fakeSessionManager);

        expect(markArchiveIngestedMock).toHaveBeenCalledTimes(2);
        expect(markArchiveIngestedMock).toHaveBeenCalledWith(k1);
        expect(markArchiveIngestedMock).toHaveBeenCalledWith(k2);
        // Persist must happen before any mark.
        expect(order).toEqual(['save', `mark:${k1}`, `mark:${k2}`]);
    });

    it('marks candidates even when there are no new messages (save skipped)', async () => {
        const k1 = 'inbox/u/archive/2025-01-10-01A';
        // An archive whose every message is already materialized in IDB yields
        // zero new messages but is still a valid ingested candidate.
        syncMessagesMock.mockResolvedValue(syncResult([], [k1]));

        await syncAndPublish(fakeSession, fakeSessionManager);

        expect(saveMessagesMock).not.toHaveBeenCalled();
        expect(markArchiveIngestedMock).toHaveBeenCalledWith(k1);
    });

    it('notifies even when sync returns no new messages (skips save)', async () => {
        syncMessagesMock.mockResolvedValue(syncResult());
        const listener = vi.fn();
        onInboxUpdated(listener);

        await syncAndPublish(fakeSession, fakeSessionManager);

        expect(saveMessagesMock).not.toHaveBeenCalled();
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('swallows sync errors and does NOT notify subscribers', async () => {
        syncMessagesMock.mockRejectedValue(new Error('boom'));
        const listener = vi.fn();
        onInboxUpdated(listener);

        await expect(
            syncAndPublish(fakeSession, fakeSessionManager),
        ).resolves.toBeUndefined();

        expect(saveMessagesMock).not.toHaveBeenCalled();
        expect(markArchiveIngestedMock).not.toHaveBeenCalled();
        expect(listener).not.toHaveBeenCalled();
    });

    it('swallows save errors and does NOT notify (stale notify would mislead)', async () => {
        syncMessagesMock.mockResolvedValue(
            syncResult(
                [
                    {
                        id: 'm1',
                        conversationId: 'dm:a:b',
                        fromUser: 'a',
                        fromDevice: 'd',
                        text: 'hi',
                        timestamp: new Date(0),
                    },
                ],
                ['inbox/u/archive/2025-01-15-01ARCHIVE'],
            ),
        );
        saveMessagesMock.mockRejectedValue(new Error('idb down'));
        const listener = vi.fn();
        onInboxUpdated(listener);

        await syncAndPublish(fakeSession, fakeSessionManager);

        expect(listener).not.toHaveBeenCalled();
        // Save failed → the archive must NOT be recorded as ingested, else its
        // messages would be skipped forever despite never landing.
        expect(markArchiveIngestedMock).not.toHaveBeenCalled();
    });

    it('isolates a throwing listener so others still receive the notification', async () => {
        syncMessagesMock.mockResolvedValue(syncResult());
        const bad = vi.fn(() => {
            throw new Error('listener boom');
        });
        const good = vi.fn();
        onInboxUpdated(bad);
        onInboxUpdated(good);

        await syncAndPublish(fakeSession, fakeSessionManager);

        expect(bad).toHaveBeenCalledTimes(1);
        expect(good).toHaveBeenCalledTimes(1);
    });
});

describe('onInboxUpdated', () => {
    it('returns an unsubscribe function that stops further notifications', async () => {
        syncMessagesMock.mockResolvedValue(syncResult());
        const listener = vi.fn();
        const unsubscribe = onInboxUpdated(listener);

        await syncAndPublish(fakeSession, fakeSessionManager);
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        await syncAndPublish(fakeSession, fakeSessionManager);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
