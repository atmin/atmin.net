// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    MAX_MEDIA_BYTES: 25 * 1024 * 1024,
    FileTooLargeError: class FileTooLargeError extends Error {
        constructor() {
            super('file exceeds MAX_MEDIA_BYTES');
            this.name = 'FileTooLargeError';
        }
    },
    encryptMedia: vi.fn().mockResolvedValue({
        ciphertext: new Uint8Array([1]),
        key: new Uint8Array([2]),
        iv: new Uint8Array([3]),
        plaintextSize: 10,
    }),
}));

// Keep the pure helpers (isOptimizableImage, fitWithin, constants) real; mock
// only the canvas-touching functions, which the unit-test DOM can't run.
vi.mock('@/lib/image', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/image')>('@/lib/image');
    return {
        ...actual,
        reencodeImage: vi.fn(),
        imageSize: vi.fn(),
        makePreview: vi.fn(),
        // Default: no preview (undefined ⇒ falsy). Preview tests opt in with
        // mockReturnValueOnce(true).
        needsPreview: vi.fn(),
    };
});

vi.mock('@/lib/photo-quality', () => ({
    getPhotoQuality: vi.fn(() => 'optimized'),
    setPhotoQuality: vi.fn(),
}));

vi.mock('@/lib/messaging', () => ({
    sendTextMessage: vi.fn().mockResolvedValue(undefined),
    sendInnerPayload: vi.fn().mockResolvedValue(undefined),
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

const fakeMgr = { destroy: vi.fn() };

describe('useChatSend', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Silence the expected catch-path alert/logs and keep window.alert
        // defined under the test DOM.
        vi.stubGlobal('alert', vi.fn());
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
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
            status: 'live',
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

    it('sendMedia calls encryptMedia + uploadMedia then sendInnerPayload + syncAndPublish', async () => {
        const { resolve, uploadMedia } = await import('@/lib/api');
        const { encryptMedia } = await import('@/lib/media');
        const { sendInnerPayload } = await import('@/lib/messaging');
        const { syncAndPublish } = await import('@/lib/inbox-sync');
        vi.mocked(resolve).mockResolvedValue({
            status: 'live',
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
        // Media flows through the typed-payload path (not double-wrapped text).
        expect(sendInnerPayload).toHaveBeenCalled();
        const payload = vi.mocked(sendInnerPayload).mock.calls[0][6];
        expect(payload).toMatchObject({
            type: 'media',
            body: 'photo.jpg',
            file: { url: 'media/user1/01ABC', name: 'photo.jpg' },
        });
        expect(syncAndPublish).toHaveBeenCalled();
    });

    it('sendMedia uses the (trimmed) caption as the message body when given', async () => {
        const { resolve, uploadMedia } = await import('@/lib/api');
        const { sendInnerPayload } = await import('@/lib/messaging');
        vi.mocked(resolve).mockResolvedValue({
            status: 'live',
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

        await act(async () => {
            await result.current.sendMedia(
                new File(['img'], 'photo.jpg'),
                '  look at this  ',
            );
        });

        const payload = vi.mocked(sendInnerPayload).mock.calls[0][6];
        expect(payload).toMatchObject({
            type: 'media',
            body: 'look at this',
            file: { name: 'photo.jpg' },
        });
    });

    it('sendMedia falls back to the filename when the caption is blank', async () => {
        const { resolve, uploadMedia } = await import('@/lib/api');
        const { sendInnerPayload } = await import('@/lib/messaging');
        vi.mocked(resolve).mockResolvedValue({
            status: 'live',
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

        await act(async () => {
            await result.current.sendMedia(
                new File(['img'], 'photo.jpg'),
                '   ',
            );
        });

        const payload = vi.mocked(sendInnerPayload).mock.calls[0][6];
        expect(payload).toMatchObject({ type: 'media', body: 'photo.jpg' });
    });

    it('second sendText while sending=true is a no-op', async () => {
        const { resolve } = await import('@/lib/api');
        const { sendTextMessage } = await import('@/lib/messaging');

        // Hang resolve so sending stays true during second call
        let resolveResolve!: () => void;
        vi.mocked(resolve).mockReturnValueOnce(
            new Promise((res) => {
                resolveResolve = () =>
                    res({
                        status: 'live',
                        user_id: 'peer',
                        sharing_public_key: 'k',
                    });
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

    // Shared setup for the optimize-path tests: a resolved recipient + a media
    // upload URL. Returns the captured outbound media payload's `file`.
    async function sendAndCaptureFile(file: File) {
        const { resolve, uploadMedia } = await import('@/lib/api');
        const { sendInnerPayload } = await import('@/lib/messaging');
        vi.mocked(resolve).mockResolvedValue({
            status: 'live',
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
        await act(async () => {
            await result.current.sendMedia(file);
        });
        const payload = vi.mocked(sendInnerPayload).mock.calls[0]?.[6];
        // Narrow the InnerPayload union to the media variant via its `file` key.
        return payload && 'file' in payload ? payload.file : undefined;
    }

    it('optimizes a photo by default: re-encodes, sends the JPEG + dimensions', async () => {
        const { reencodeImage } = await import('@/lib/image');
        const { encryptMedia } = await import('@/lib/media');
        const { getPhotoQuality } = await import('@/lib/photo-quality');
        vi.mocked(getPhotoQuality).mockReturnValue('optimized');
        const reBlob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' });
        vi.mocked(reencodeImage).mockResolvedValue({
            blob: reBlob,
            width: 2048,
            height: 1536,
        });

        const file = new File(['raw'], 'photo.png', { type: 'image/png' });
        const sent = await sendAndCaptureFile(file);

        // The re-encoded blob is what gets encrypted, not the original file.
        expect(encryptMedia).toHaveBeenCalledWith(reBlob);
        expect(sent).toMatchObject({
            name: 'photo.png',
            mime: 'image/jpeg',
            optimized: true,
            width: 2048,
            height: 1536,
            size: 10, // enc.plaintextSize from the media mock
        });
    });

    it('original-quality opt-out sends untouched bytes, labelled + dimensioned', async () => {
        const { reencodeImage, imageSize } = await import('@/lib/image');
        const { encryptMedia } = await import('@/lib/media');
        const { getPhotoQuality } = await import('@/lib/photo-quality');
        vi.mocked(getPhotoQuality).mockReturnValue('original');
        vi.mocked(imageSize).mockResolvedValue({ width: 4032, height: 3024 });

        const file = new File(['raw'], 'photo.jpg', { type: 'image/jpeg' });
        const sent = await sendAndCaptureFile(file);

        expect(reencodeImage).not.toHaveBeenCalled();
        expect(encryptMedia).toHaveBeenCalledWith(file);
        expect(sent).toMatchObject({
            mime: 'image/jpeg',
            optimized: false,
            width: 4032,
            height: 3024,
        });
    });

    it('never optimizes a GIF — untouched bytes, labelled, no re-encode', async () => {
        const { reencodeImage, imageSize } = await import('@/lib/image');
        const { encryptMedia } = await import('@/lib/media');
        vi.mocked(imageSize).mockResolvedValue({ width: 320, height: 240 });

        const file = new File(['gif'], 'meme.gif', { type: 'image/gif' });
        const sent = await sendAndCaptureFile(file);

        expect(reencodeImage).not.toHaveBeenCalled();
        expect(encryptMedia).toHaveBeenCalledWith(file);
        expect(sent).toMatchObject({
            mime: 'image/gif',
            optimized: false,
            width: 320,
            height: 240,
        });
    });

    it('fails closed when re-encode fails — never silently ships the un-stripped original', async () => {
        const { reencodeImage } = await import('@/lib/image');
        const { encryptMedia } = await import('@/lib/media');
        const { resolve, uploadMedia } = await import('@/lib/api');
        const { sendInnerPayload } = await import('@/lib/messaging');
        const { getPhotoQuality } = await import('@/lib/photo-quality');
        vi.mocked(getPhotoQuality).mockReturnValue('optimized');
        vi.mocked(reencodeImage).mockRejectedValue(new Error('decode failed'));
        vi.mocked(resolve).mockResolvedValue({
            status: 'live',
            user_id: 'peer-user',
            sharing_public_key: 'peer-key-b64',
        });

        const { useChatSend } = await import('./useChatSend');
        const { result } = renderHook(() =>
            useChatSend('bob', false, fakeSession, fakeMgr as never),
        );
        const file = new File(['raw'], 'weird.png', { type: 'image/png' });
        await act(async () => {
            await result.current.sendMedia(file);
        });

        // The original bytes (and their EXIF) are never encrypted, uploaded, or
        // referenced in an envelope.
        expect(reencodeImage).toHaveBeenCalled();
        expect(encryptMedia).not.toHaveBeenCalled();
        expect(uploadMedia).not.toHaveBeenCalled();
        expect(sendInnerPayload).not.toHaveBeenCalled();
    });

    it('generates a preview above the threshold: uploads full + preview and sets file.preview', async () => {
        const { reencodeImage, makePreview, needsPreview } = await import(
            '@/lib/image'
        );
        const { uploadMedia } = await import('@/lib/api');
        const { getPhotoQuality } = await import('@/lib/photo-quality');
        vi.mocked(getPhotoQuality).mockReturnValue('optimized');
        vi.mocked(reencodeImage).mockResolvedValue({
            blob: new Blob(['full']),
            width: 2048,
            height: 1536,
        });
        vi.mocked(needsPreview).mockReturnValueOnce(true);
        vi.mocked(makePreview).mockResolvedValue({
            blob: new Blob(['prev']),
            width: 320,
            height: 240,
        });

        const file = new File(['raw'], 'photo.jpg', { type: 'image/jpeg' });
        const sent = await sendAndCaptureFile(file);

        expect(makePreview).toHaveBeenCalled();
        expect(uploadMedia).toHaveBeenCalledTimes(2); // full + preview
        expect(sent).toMatchObject({
            optimized: true,
            preview: { width: 320, height: 240 },
        });
    });

    it('skips the preview below the threshold: a single upload, no preview field', async () => {
        const { reencodeImage, makePreview, needsPreview } = await import(
            '@/lib/image'
        );
        const { uploadMedia } = await import('@/lib/api');
        const { getPhotoQuality } = await import('@/lib/photo-quality');
        vi.mocked(getPhotoQuality).mockReturnValue('optimized');
        vi.mocked(reencodeImage).mockResolvedValue({
            blob: new Blob(['full']),
            width: 800,
            height: 600,
        });
        vi.mocked(needsPreview).mockReturnValue(false);

        const file = new File(['raw'], 'small.jpg', { type: 'image/jpeg' });
        const sent = await sendAndCaptureFile(file);

        expect(makePreview).not.toHaveBeenCalled();
        expect(uploadMedia).toHaveBeenCalledTimes(1);
        expect(sent?.preview).toBeUndefined();
    });

    it('rejects an oversize source before re-encoding or uploading', async () => {
        const { reencodeImage } = await import('@/lib/image');
        const { encryptMedia } = await import('@/lib/media');
        const { uploadMedia } = await import('@/lib/api');
        const { sendInnerPayload } = await import('@/lib/messaging');

        const big = new File(['x'], 'huge.jpg', { type: 'image/jpeg' });
        Object.defineProperty(big, 'size', {
            value: 26 * 1024 * 1024,
            configurable: true,
        });

        const { useChatSend } = await import('./useChatSend');
        const { result } = renderHook(() =>
            useChatSend('bob', false, fakeSession, fakeMgr as never),
        );
        await act(async () => {
            await result.current.sendMedia(big);
        });

        expect(reencodeImage).not.toHaveBeenCalled();
        expect(encryptMedia).not.toHaveBeenCalled();
        expect(uploadMedia).not.toHaveBeenCalled();
        expect(sendInnerPayload).not.toHaveBeenCalled();
    });
});
