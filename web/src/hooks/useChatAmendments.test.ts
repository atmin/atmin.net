// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/auth';

vi.mock('@/lib/amendments', () => ({
    sendAmendment: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/api', () => ({
    storeDelete: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db', () => ({
    deleteMediaBlob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/inbox-sync', () => ({
    syncAndPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/recipient', () => ({
    resolveRecipient: vi.fn().mockResolvedValue({
        recipientUserId: 'peer-user',
        recipientPubKeyBytes: new Uint8Array([9]),
    }),
}));

const fakeSession: Session = {
    token: 'tok',
    userId: 'user1',
    deviceId: 'dev1',
    handle: 'alice',
    sharingPrivateKey: {} as CryptoKey,
    sharingPublicKeyBytes: new Uint8Array([1, 2, 3]),
    backupKey: {} as CryptoKey,
    keyVersion: 1,
};

const fakeMgr = {} as never;

describe('useChatAmendments', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('editMessage sends an edit amendment then syncs', async () => {
        const { sendAmendment } = await import('@/lib/amendments');
        const { syncAndPublish } = await import('@/lib/inbox-sync');
        const { useChatAmendments } = await import('./useChatAmendments');

        const { result } = renderHook(() =>
            useChatAmendments('bob', false, fakeSession, fakeMgr),
        );
        await act(async () => {
            await result.current.editMessage('01TARGET', 'new body');
        });

        expect(sendAmendment).toHaveBeenCalledTimes(1);
        const args = vi.mocked(sendAmendment).mock.calls[0];
        expect(args[6]).toBe('01TARGET'); // targetMsgId
        expect(args[7]).toBe('edit'); // action
        expect(args[8]).toBe('new body'); // body
        expect(syncAndPublish).toHaveBeenCalled();
    });

    it('deleteMessage sends a delete amendment + storeDelete for each object url', async () => {
        const { sendAmendment } = await import('@/lib/amendments');
        const { storeDelete } = await import('@/lib/api');
        const { useChatAmendments } = await import('./useChatAmendments');

        const { result } = renderHook(() =>
            useChatAmendments('bob', false, fakeSession, fakeMgr),
        );
        await act(async () => {
            await result.current.deleteMessage('01TARGET', [
                'media/user1/01ABC',
            ]);
        });

        const args = vi.mocked(sendAmendment).mock.calls[0];
        expect(args[7]).toBe('delete');
        expect(args[8]).toBeUndefined(); // no body on delete
        expect(storeDelete).toHaveBeenCalledWith('tok', 'media/user1/01ABC');
    });

    it('deleteMessage sweeps the full object set (full + preview)', async () => {
        const { storeDelete } = await import('@/lib/api');
        const { useChatAmendments } = await import('./useChatAmendments');

        const { result } = renderHook(() =>
            useChatAmendments('bob', false, fakeSession, fakeMgr),
        );
        await act(async () => {
            await result.current.deleteMessage('01TARGET', [
                'media/user1/full',
                'media/user1/preview',
            ]);
        });

        expect(storeDelete).toHaveBeenCalledWith('tok', 'media/user1/full');
        expect(storeDelete).toHaveBeenCalledWith('tok', 'media/user1/preview');
        expect(storeDelete).toHaveBeenCalledTimes(2);
    });

    it('deleteMessage evicts each swept url from the local media cache', async () => {
        const { deleteMediaBlob } = await import('@/lib/db');
        const { useChatAmendments } = await import('./useChatAmendments');

        const { result } = renderHook(() =>
            useChatAmendments('bob', false, fakeSession, fakeMgr),
        );
        await act(async () => {
            await result.current.deleteMessage('01TARGET', [
                'media/user1/full',
                'media/user1/preview',
            ]);
        });

        expect(deleteMediaBlob).toHaveBeenCalledWith('media/user1/full');
        expect(deleteMediaBlob).toHaveBeenCalledWith('media/user1/preview');
        expect(deleteMediaBlob).toHaveBeenCalledTimes(2);
    });

    it('deleteMessage without media urls does not call storeDelete or evict', async () => {
        const { storeDelete } = await import('@/lib/api');
        const { deleteMediaBlob } = await import('@/lib/db');
        const { useChatAmendments } = await import('./useChatAmendments');

        const { result } = renderHook(() =>
            useChatAmendments('bob', false, fakeSession, fakeMgr),
        );
        await act(async () => {
            await result.current.deleteMessage('01TARGET');
        });

        expect(storeDelete).not.toHaveBeenCalled();
        expect(deleteMediaBlob).not.toHaveBeenCalled();
    });

    it('deleteMessage still succeeds when storeDelete fails (best-effort)', async () => {
        const { storeDelete } = await import('@/lib/api');
        const { syncAndPublish } = await import('@/lib/inbox-sync');
        const { useChatAmendments } = await import('./useChatAmendments');
        vi.mocked(storeDelete).mockRejectedValueOnce(new Error('500'));

        const { result } = renderHook(() =>
            useChatAmendments('bob', false, fakeSession, fakeMgr),
        );
        await act(async () => {
            await result.current.deleteMessage('01TARGET', [
                'media/user1/01ABC',
            ]);
        });

        // The amendment path completed (synced) despite the blob delete failing.
        expect(syncAndPublish).toHaveBeenCalled();
    });
});
