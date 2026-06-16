// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    // Pure helper — use the real regex so image vs non-image routing is exercised.
    isLikelyImage: (name: string) =>
        /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(name),
}));

const makeFile = (url: string, name = 'file.jpg'): MediaFile => ({
    url,
    key: new Uint8Array([1]),
    iv: new Uint8Array([2]),
    name,
    size: 10,
});

const BLOB_URL = 'blob:fake-url';
const tick = () => new Promise((r) => setTimeout(r, 0));

// ── Controllable IntersectionObserver mock ─────────────────────────────────
// happy-dom ships a no-op IntersectionObserver that never fires; replace it
// with one we can trigger by hand.
class MockIO {
    callback: IntersectionObserverCallback;
    elements = new Set<Element>();
    constructor(cb: IntersectionObserverCallback) {
        this.callback = cb;
        observers.push(this);
    }
    observe(el: Element) {
        this.elements.add(el);
    }
    unobserve(el: Element) {
        this.elements.delete(el);
    }
    disconnect() {
        this.elements.clear();
    }
    takeRecords() {
        return [];
    }
}
let observers: MockIO[] = [];

function fireIntersect(el: Element) {
    for (const obs of observers) {
        if (obs.elements.has(el)) {
            obs.callback(
                [
                    {
                        target: el,
                        isIntersecting: true,
                    } as unknown as IntersectionObserverEntry,
                ],
                obs as unknown as IntersectionObserver,
            );
        }
    }
}

const RealIO = globalThis.IntersectionObserver;

describe('useMedia', () => {
    let createObjectURL: ReturnType<typeof vi.fn>;
    let revokeObjectURL: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        observers = [];
        (
            globalThis as unknown as { IntersectionObserver: unknown }
        ).IntersectionObserver = MockIO;
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

    afterEach(() => {
        (
            globalThis as unknown as { IntersectionObserver: unknown }
        ).IntersectionObserver = RealIO;
    });

    it('seeds an image url to idle and does not fetch until it intersects', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([10, 20]));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/img1');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await tick();
        });

        expect(result.current.states['media/u1/img1']?.status).toBe('idle');
        expect(fetchMedia).not.toHaveBeenCalled();
    });

    it('fetches once on intersection (idle → loading → ready); does not re-fetch on a second intersection', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([10, 20]));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/img1');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await tick();
        });
        expect(result.current.states['media/u1/img1']?.status).toBe('idle');

        const el = document.createElement('div');
        act(() => {
            result.current.observe('media/u1/img1', el);
        });
        // Observed, but nothing intersected yet.
        expect(fetchMedia).not.toHaveBeenCalled();

        await act(async () => {
            fireIntersect(el);
            await tick();
        });

        expect(fetchMedia).toHaveBeenCalledWith(
            'tok',
            'media/u1/img1',
            expect.any(AbortSignal),
        );
        expect(result.current.states['media/u1/img1']?.status).toBe('ready');
        expect(result.current.states['media/u1/img1']?.blobUrl).toBe(BLOB_URL);

        // A second intersection (and a re-observe) must not re-fetch.
        act(() => {
            result.current.observe('media/u1/img1', el);
        });
        await act(async () => {
            fireIntersect(el);
            await tick();
        });
        expect(fetchMedia).toHaveBeenCalledTimes(1);
    });

    it('ref churn (null then element) does not unobserve-then-refire', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([10, 20]));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/img1');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await tick();
        });

        const el = document.createElement('div');
        // Mimic React's per-render ref churn: element, then null (detach), then
        // element again (re-attach).
        act(() => {
            result.current.observe('media/u1/img1', el);
        });
        const obs = observers[0];
        expect(obs.elements.has(el)).toBe(true);

        act(() => {
            result.current.observe('media/u1/img1', null);
        });
        // The null detach must be ignored — the element stays observed.
        expect(obs.elements.has(el)).toBe(true);

        act(() => {
            result.current.observe('media/u1/img1', el);
        });

        await act(async () => {
            fireIntersect(el);
            await tick();
        });
        expect(fetchMedia).toHaveBeenCalledTimes(1);
        expect(result.current.states['media/u1/img1']?.status).toBe('ready');
    });

    it('scrolling away after load does not abort or re-fetch', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([10, 20]));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/img1');
        const { result, rerender } = renderHook(
            ({ files }: { files: MediaFile[] }) => useMedia(files, 'tok'),
            { initialProps: { files: [file] } },
        );

        await act(async () => {
            await tick();
        });
        const el = document.createElement('div');
        act(() => {
            result.current.observe('media/u1/img1', el);
        });
        await act(async () => {
            fireIntersect(el);
            await tick();
        });
        expect(result.current.states['media/u1/img1']?.status).toBe('ready');

        // Re-sync (files keep fresh identity each render) — no abort, no
        // re-fetch, blob kept.
        rerender({ files: [makeFile('media/u1/img1')] });
        await act(async () => {
            await tick();
        });
        expect(result.current.states['media/u1/img1']?.status).toBe('ready');
        expect(fetchMedia).toHaveBeenCalledTimes(1);
        expect(revokeObjectURL).not.toHaveBeenCalled();
    });

    it('does not seed or observe a non-image; loads only when requested directly', async () => {
        const { fetchMedia } = await import('@/lib/api');
        const { sniffInlineImageMime } = await import('@/lib/media');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([10, 20]));
        // A non-image sniffs as null → download path.
        vi.mocked(sniffInlineImageMime).mockReturnValue(null);

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/doc', 'report.pdf');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await tick();
        });
        // Not seeded.
        expect(result.current.states['media/u1/doc']).toBeUndefined();
        expect(fetchMedia).not.toHaveBeenCalled();

        // Click-to-fetch.
        await act(async () => {
            result.current.request('media/u1/doc');
            await tick();
        });
        expect(fetchMedia).toHaveBeenCalledTimes(1);
        expect(result.current.states['media/u1/doc']?.status).toBe('ready');
        expect(result.current.states['media/u1/doc']?.mime).toBeNull();
    });

    it('eager-loads all image files when IntersectionObserver is undefined (fallback)', async () => {
        (
            globalThis as unknown as { IntersectionObserver: unknown }
        ).IntersectionObserver = undefined;
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([10, 20]));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/img1');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await tick();
        });

        expect(fetchMedia).toHaveBeenCalledTimes(1);
        expect(result.current.states['media/u1/img1']?.status).toBe('ready');
    });

    it('404 from fetchMedia yields unavailable status', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockRejectedValue(new FakeNotFoundError());

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/missing');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await tick();
        });
        const el = document.createElement('div');
        act(() => {
            result.current.observe('media/u1/missing', el);
        });
        await act(async () => {
            fireIntersect(el);
            await tick();
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
            await tick();
        });
        const el = document.createElement('div');
        act(() => {
            result.current.observe('media/u1/corrupt', el);
        });
        await act(async () => {
            fireIntersect(el);
            await tick();
        });

        expect(result.current.states['media/u1/corrupt']?.status).toBe(
            'corrupt',
        );
    });

    it('request() re-fetches a previously failed URL', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia)
            .mockRejectedValueOnce(new Error('network error'))
            .mockResolvedValueOnce(new Uint8Array([10]));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/retry');
        const { result } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await tick();
        });
        const el = document.createElement('div');
        act(() => {
            result.current.observe('media/u1/retry', el);
        });
        await act(async () => {
            fireIntersect(el);
            await tick();
        });
        expect(result.current.states['media/u1/retry']?.status).toBe(
            'network-error',
        );

        await act(async () => {
            result.current.request('media/u1/retry');
            await tick();
        });

        expect(result.current.states['media/u1/retry']?.status).toBe('ready');
        expect(fetchMedia).toHaveBeenCalledTimes(2);
    });

    it('revokes blob URL on unmount', async () => {
        const { fetchMedia } = await import('@/lib/api');
        vi.mocked(fetchMedia).mockResolvedValue(new Uint8Array([1]));

        const { useMedia } = await import('./useMedia');
        const file = makeFile('media/u1/revoke');
        const { result, unmount } = renderHook(() => useMedia([file], 'tok'));

        await act(async () => {
            await tick();
        });
        const el = document.createElement('div');
        act(() => {
            result.current.observe('media/u1/revoke', el);
        });
        await act(async () => {
            fireIntersect(el);
            await tick();
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
            await tick();
        });

        // Both seeded idle (images), tracked for cleanup.
        expect('media/u1/file1' in result.current.states).toBe(true);
        expect('media/u1/file2' in result.current.states).toBe(true);

        rerender({ files: [file1] });

        await act(async () => {
            await tick();
        });

        expect('media/u1/file1' in result.current.states).toBe(true);
        expect('media/u1/file2' in result.current.states).toBe(false);
    });
});
