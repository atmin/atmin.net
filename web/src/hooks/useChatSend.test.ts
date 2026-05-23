// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/auth';

vi.mock('@/lib/api', () => ({
    resolve: vi.fn(),
    uploadMedia: vi.fn(),
}));

vi.mock('@/lib/crypto', () => ({
    base64UrlDecode: vi.fn().mockReturnValue(new Uint8Array([5, 6, 7])),
    base64UrlEncode: vi.fn().mockReturnValue('encoded-key'),
}));

vi.mock('@/lib/inbox-sync', () => ({
    syncAndPublish: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/media', () => ({
    encryptMedia: vi.fn().mockResolvedValue({
        ciphertext: new Uint8Array([1]),
        key: new Uint8Array([2]),
        iv: new Uint8Array([3]),
        plaintextSize: 10,
    }),
}));

vi.mock('@/lib/messaging', () => ({
    sendTextMessage: vi.fn().mockResolvedValue(undefined),
}));

const fakeSession: Session = {
    token: 'tok',
    userId: 'user1',
    deviceId: 'dev1',
    handle: 'alice',
    sharingPrivateKey: {} as CryptoKey,
    sharingPublicKeyBytes: new Uint8Array([1, 2, 3]),
    backupKey: {} as CryptoKey,
};

const fakeMgr = { destroy: vi.fn() };

describe('useChatSend', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sendText returns immediately when sessionManager is null', async () => {
        const { sendTextMessage } = await import('@/lib/messaging');
        const { useChatSend } = await import('./useChatSend');
        const { result } = renderHook(() =>
            useChatSend('alice', false, fakeSession, null),
        );

        await act(async () => {
            await result.current.sendText('hello');
        });

        expect(sendTextMessage).not.toHaveBeenCalled();
    });

    it('sendMedia returns immediately when sessionManager is null', async () => {
        const { encryptMedia } = await import('@/lib/media');
        const { useChatSend } = await import('./useChatSend');
        const { result } = renderHook(() =>
            useChatSend('alice', false, fakeSession, null),
        );

        await act(async () => {
            await result.current.sendMedia(new File(['data'], 'test.jpg'));
        });

        expect(encryptMedia).not.toHaveBeenCalled();
    });

    it('Saved Messages path: sendText uses own userId/key without calling resolve', async () => {
        const { resolve } = await import('@/lib/api');
        const { sendTextMessage } = await import('@/lib/messaging');
        const { syncAndPublish } = await import('@/lib/inbox-sync');

        const { useChatSend } = await import('./useChatSend');
        const { result } = renderHook(() =>
            useChatSend('saved', true, fakeSession, fakeMgr as never),
        );

        await act(async () => {
            await result.current.sendText('hello saved');
        });

        expect(resolve).not.toHaveBeenCalled();
        expect(sendTextMessage).toHaveBeenCalledWith(
            fakeSession.token,
            fakeSession.userId,
            fakeSession.deviceId,
            fakeSession.userId, // recipient = self
            fakeSession.sharingPublicKeyBytes, // own key
            fakeSession.sharingPublicKeyBytes,
            'hello saved',
            fakeMgr,
        );
        expect(syncAndPublish).toHaveBeenCalledWith(fakeSession, fakeMgr);
    });

    it('DM path: sendText calls resolve(handle) and decodes the returned key', async () => {
        const { resolve } = await import('@/lib/api');
        const { base64UrlDecode } = await import('@/lib/crypto');
        const { sendTextMessage } = await import('@/lib/messaging');
        vi.mocked(resolve).mockResolvedValue({
            user_id: 'peer-user',
            sharing_public_key: 'peer-key-b64',
        });

        const { useChatSend } = await import('./useChatSend');
        const { result } = renderHook(() =>
            useChatSend('bob', false, fakeSession, fakeMgr as never),
        );

        await act(async () => {
            await result.current.sendText('hi bob');
        });

        expect(resolve).toHaveBeenCalledWith('bob');
        expect(base64UrlDecode).toHaveBeenCalledWith('peer-key-b64');
        expect(sendTextMessage).toHaveBeenCalledWith(
            fakeSession.token,
            fakeSession.userId,
            fakeSession.deviceId,
            'peer-user',
            new Uint8Array([5, 6, 7]), // decoded key from mock
            fakeSession.sharingPublicKeyBytes,
            'hi bob',
            fakeMgr,
        );
    });

    it('sendMedia calls encryptMedia + uploadMedia then sendTextMessage + syncAndPublish', async () => {
        const { resolve, uploadMedia } = await import('@/lib/api');
        const { encryptMedia } = await import('@/lib/media');
        const { sendTextMessage } = await import('@/lib/messaging');
        const { syncAndPublish } = await import('@/lib/inbox-sync');
        vi.mocked(resolve).mockResolvedValue({
            user_id: 'peer-user',
            sharing_public_key: 'peer-key-b64',
        });
        vi.mocked(uploadMedia).mockResolvedValue({
            url: 'media/user1/01ABC',
            mediaUlid: '01ABC',
        });

        const { useChatSend } = await import('./useChatSend');
        const { result } = renderHook(() =>
            useChatSend('bob', false, fakeSession, fakeMgr as never),
        );

        const file = new File(['img'], 'photo.jpg');
        await act(async () => {
            await result.current.sendMedia(file);
        });

        expect(encryptMedia).toHaveBeenCalledWith(file);
        expect(uploadMedia).toHaveBeenCalled();
        expect(sendTextMessage).toHaveBeenCalled();
        expect(syncAndPublish).toHaveBeenCalled();
    });

    it('second sendText while sending=true is a no-op', async () => {
        const { resolve } = await import('@/lib/api');
        const { sendTextMessage } = await import('@/lib/messaging');

        // Hang resolve so sending stays true during second call
        let resolveResolve!: () => void;
        vi.mocked(resolve).mockReturnValueOnce(
            new Promise((res) => {
                resolveResolve = () =>
                    res({ user_id: 'peer', sharing_public_key: 'k' });
            }),
        );

        const { useChatSend } = await import('./useChatSend');
        const { result } = renderHook(() =>
            useChatSend('bob', false, fakeSession, fakeMgr as never),
        );

        // Fire first sendText without awaiting (it will hang on resolve)
        act(() => {
            void result.current.sendText('first');
        });

        // While sending, fire second sendText — should be ignored
        await act(async () => {
            await result.current.sendText('second');
        });

        // Let the first one complete
        await act(async () => {
            resolveResolve();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(sendTextMessage).toHaveBeenCalledTimes(1);
    });

    it('sendText is a no-op when offline', async () => {
        const onLineSpy = vi
            .spyOn(navigator, 'onLine', 'get')
            .mockReturnValue(false);
        try {
            const { sendTextMessage } = await import('@/lib/messaging');

            const { useChatSend } = await import('./useChatSend');
            const { result } = renderHook(() =>
                useChatSend('bob', false, fakeSession, fakeMgr as never),
            );

            expect(result.current.online).toBe(false);

            await act(async () => {
                await result.current.sendText('while offline');
            });

            expect(sendTextMessage).not.toHaveBeenCalled();
        } finally {
            onLineSpy.mockRestore();
        }
    });

    it('sendMedia is a no-op when offline', async () => {
        const onLineSpy = vi
            .spyOn(navigator, 'onLine', 'get')
            .mockReturnValue(false);
        try {
            const { encryptMedia } = await import('@/lib/media');

            const { useChatSend } = await import('./useChatSend');
            const { result } = renderHook(() =>
                useChatSend('bob', false, fakeSession, fakeMgr as never),
            );

            await act(async () => {
                await result.current.sendMedia(new File(['x'], 'x.jpg'));
            });

            expect(encryptMedia).not.toHaveBeenCalled();
        } finally {
            onLineSpy.mockRestore();
        }
    });
});
