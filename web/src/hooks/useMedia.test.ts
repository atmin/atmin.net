// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaFile } from '@/lib/media';

class FakeNotFoundError extends Error {
    constructor() {
        super('not found');
        this.name = 'NotFoundError';
    }
}

class FakeMediaCorruptError extends Error {
    constructor() {
        super('corrupt');
        this.name = 'MediaCorruptError';
    }
}

vi.mock('@/lib/api', () => ({
    fetchMedia: vi.fn(),
    NotFoundError: FakeNotFoundError,
}));

vi.mock('@/lib/media', () => ({
    decryptMedia: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    MediaCorruptError: FakeMediaCorruptError,
    sniffInlineImageMime: vi.fn().mockReturnValue('image/jpeg'),
}));

const makeFile = (url: string): MediaFile => ({
    url,
    key: new Uint8Array([1]),
    iv: new Uint8Array([2]),
    name: 'file.jpg',
    size: 10,
});

const BLOB_URL = 'blob:fake-url';

describe('useMedia', () => {
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        createObjectURL = vi.fn().mockReturnValue(BLOB_URL);
        revokeObjectURL = vi.fn();
        Object.defineProperty(URL, 'createObjectURL', {
            value: createObjectURL,
            writable: true,
            configurable: true,
        });
        Object.defineProperty(URL, 'revokeObjectURL', {
            value: revokeObjectURL,
            writable: true,
            configurable: true,
        });
    });

    it('fetches and decrypts a file, resulting in ready state with blobUrl', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([10, 20]));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/img1');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        expect(result.current.states['media/u1/img1']?.status).toBe('loading');

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(fetchMedia).toHaveBeenCalledWith(
            'tok',
            'media/u1/img1',
            expect.any(AbortSignal),
        );
        expect(result.current.states['media/u1/img1']?.status).toBe('ready');
        expect(result.current.states['media/u1/img1']?.blobUrl).toBe(BLOB_URL);
        expect(result.current.states['media/u1/img1']?.mime).toBe('image/jpeg');
    });

    it('404 from fetchMedia yields unavailable status', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockRejectedValue(new FakeNotFoundError());

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/missing');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(result.current.states['media/u1/missing']?.status).toBe(
            'unavailable',
        );
    });

    it('decryption failure yields corrupt status', async () => {
        const { fetchMedia } = await import('@/lib/api');
        const { decryptMedia } = await import('@/lib/media');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([99]));
        vi.mocked(decryptMedia).mockRejectedValueOnce(
            new FakeMediaCorruptError(),
        );

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/corrupt');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(result.current.states['media/u1/corrupt']?.status).toBe(
            'corrupt',
        );
    });

    it('5xx error yields network-error status', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockRejectedValue(new Error('network error'));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/fail');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(result.current.states['media/u1/fail']?.status).toBe(
            'network-error',
        );
    });

    it('retry re-fetches a previously failed URL', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia)
            .mockRejectedValueOnce(new Error('network error'))
            .mockResolvedValueOnce(new Uint8Array([10]));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/retry');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });
        expect(result.current.states['media/u1/retry']?.status).toBe(
            'network-error',
        );

        await act(async () => {
            result.current.retry('media/u1/retry');
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(result.current.states['media/u1/retry']?.status).toBe('ready');
        expect(fetchMedia).toHaveBeenCalledTimes(2);
    });

    it('revokes blob URL on unmount', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([1]));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/revoke');
        const { unmount } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });
        expect(createObjectURL).toHaveBeenCalled();

        unmount();

        expect(revokeObjectURL).toHaveBeenCalledWith(BLOB_URL);
    });

    it('removes state and aborts controller when file leaves the list', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([1]));

        const { useMedia } = await import('./useMedia');
        const file1 = makeFile('media/u1/file1');
        const file2 = makeFile('media/u1/file2');

        const { result, rerender } = renderHook(
            ({ files }: { files: MediaFile[] }) => useMedia(files, 'tok'),
            { initialProps: { files: [file1, file2] } },
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect('media/u1/file1' in result.current.states).toBe(true);
        expect('media/u1/file2' in result.current.states).toBe(true);

        rerender({ files: [file1] });

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect('media/u1/file1' in result.current.states).toBe(true);
        expect('media/u1/file2' in result.current.states).toBe(false);
    });
});
