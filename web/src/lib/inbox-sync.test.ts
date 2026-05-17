import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./messaging', () => ({
    syncMessages: vi.fn(),
}));
vi.mock('./db', () => ({
    saveMessages: vi.fn(),
}));

import { saveMessages } from './db';
import {
    _resetInboxListeners,
    onInboxUpdated,
    syncAndPublish,
} from './inbox-sync';
import { syncMessages } from './messaging';

const syncMessagesMock = vi.mocked(syncMessages);
const saveMessagesMock = vi.mocked(saveMessages);

// Minimal Session stub; only fields syncAndPublish forwards into syncMessages.
const fakeSession = {
    token: 't',
    userId: 'u',
    deviceId: 'd',
    handle: 'h',
    sharingPrivateKey: 'pk' as unknown as CryptoKey,
    sharingPublicKeyBytes: new Uint8Array(),
    backupKey: 'bk' as unknown as CryptoKey,
};
const fakeSessionManager = {} as Parameters<typeof syncAndPublish>[1];

beforeEach(() => {
    _resetInboxListeners();
    syncMessagesMock.mockReset();
    saveMessagesMock.mockReset();
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
        syncMessagesMock.mockResolvedValue([msg]);
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
        );
        expect(saveMessagesMock).toHaveBeenCalledWith('u', [msg]);
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('notifies even when sync returns no new messages (skips save)', async () => {
        syncMessagesMock.mockResolvedValue([]);
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
        expect(listener).not.toHaveBeenCalled();
    });

    it('swallows save errors and does NOT notify (stale notify would mislead)', async () => {
        syncMessagesMock.mockResolvedValue([
            {
                id: 'm1',
                conversationId: 'dm:a:b',
                fromUser: 'a',
                fromDevice: 'd',
                text: 'hi',
                timestamp: new Date(0),
            },
        ]);
        saveMessagesMock.mockRejectedValue(new Error('idb down'));
        const listener = vi.fn();
        onInboxUpdated(listener);

        await syncAndPublish(fakeSession, fakeSessionManager);

        expect(listener).not.toHaveBeenCalled();
    });

    it('isolates a throwing listener so others still receive the notification', async () => {
        syncMessagesMock.mockResolvedValue([]);
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
        syncMessagesMock.mockResolvedValue([]);
        const listener = vi.fn();
        const unsubscribe = onInboxUpdated(listener);

        await syncAndPublish(fakeSession, fakeSessionManager);
        expect(listener).toHaveBeenCalledTimes(1);

        unsubscribe();
        await syncAndPublish(fakeSession, fakeSessionManager);
        expect(listener).toHaveBeenCalledTimes(1);
    });
});
