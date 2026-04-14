import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchMedia, NetworkError, NotFoundError, uploadMedia } from './api';
import type { EncryptedMedia } from './media';

const fetchMock = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
    globalThis.fetch = fetchMock as typeof fetch;
    fetchMock.mockReset();
});
afterEach(() => {
    globalThis.fetch = originalFetch;
});

function okJson(data: unknown): Response {
    return {
        ok: true,
        status: 200,
        headers: {
            get: (n: string) =>
                n === 'content-type' ? 'application/json' : null,
        },
        json: async () => data,
    } as unknown as Response;
}
function okPut(): Response {
    return { ok: true, status: 200 } as unknown as Response;
}
function status(s: number): Response {
    return {
        ok: false,
        status: s,
        statusText: `status ${s}`,
        headers: { get: () => null },
        json: async () => ({ error: 'err', message: 'err' }),
    } as unknown as Response;
}

function fakeEncrypted(): EncryptedMedia {
    return {
        ciphertext: new Uint8Array([1, 2, 3]),
        key: new Uint8Array(32),
        iv: new Uint8Array(12),
        plaintextSize: 3,
    };
}

describe('uploadMedia', () => {
    it('presigns then PUTs, returning key and ulid', async () => {
        fetchMock
            .mockResolvedValueOnce(okJson({ presigned_url: 'https://s3/x' }))
            .mockResolvedValueOnce(okPut());

        const { url, mediaUlid } = await uploadMedia(
            'tok',
            'u1',
            fakeEncrypted(),
        );
        expect(url).toBe(`media/u1/${mediaUlid}`);
        expect(mediaUlid).toMatch(/^[0-9A-Z]{26}$/);
        expect(fetchMock).toHaveBeenCalledTimes(2);

        const [, putInit] = fetchMock.mock.calls[1];
        expect(putInit.method).toBe('PUT');
        expect(putInit.headers['Content-Type']).toBe(
            'application/octet-stream',
        );
    });

    it('retries PUT once on 5xx', async () => {
        fetchMock
            .mockResolvedValueOnce(okJson({ presigned_url: 'https://s3/x' }))
            .mockResolvedValueOnce(status(503))
            .mockResolvedValueOnce(okPut());

        const res = await uploadMedia('tok', 'u1', fakeEncrypted());
        expect(res.url).toMatch(/^media\/u1\//);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('retries PUT once on network error', async () => {
        fetchMock
            .mockResolvedValueOnce(okJson({ presigned_url: 'https://s3/x' }))
            .mockRejectedValueOnce(new TypeError('network down'))
            .mockResolvedValueOnce(okPut());

        const res = await uploadMedia('tok', 'u1', fakeEncrypted());
        expect(res.url).toMatch(/^media\/u1\//);
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not retry on 4xx', async () => {
        fetchMock
            .mockResolvedValueOnce(okJson({ presigned_url: 'https://s3/x' }))
            .mockResolvedValueOnce(status(403));

        await expect(
            uploadMedia('tok', 'u1', fakeEncrypted()),
        ).rejects.toThrow();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });
});

describe('fetchMedia', () => {
    it('returns bytes on 200', async () => {
        const body = new Uint8Array([9, 8, 7]);
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            arrayBuffer: async () => body.buffer,
        } as unknown as Response);

        const ctl = new AbortController();
        const out = await fetchMedia('tok', 'media/u/abc', ctl.signal);
        expect(Array.from(out)).toEqual([9, 8, 7]);
    });

    it('throws NotFoundError on 404', async () => {
        fetchMock.mockResolvedValueOnce(status(404));
        const ctl = new AbortController();
        await expect(
            fetchMedia('tok', 'media/u/abc', ctl.signal),
        ).rejects.toThrow(NotFoundError);
    });

    it('throws NetworkError on non-404 non-ok', async () => {
        fetchMock.mockResolvedValueOnce(status(500));
        const ctl = new AbortController();
        await expect(
            fetchMedia('tok', 'media/u/abc', ctl.signal),
        ).rejects.toThrow(NetworkError);
    });

    it('throws NetworkError when fetch rejects', async () => {
        fetchMock.mockRejectedValueOnce(new TypeError('network down'));
        const ctl = new AbortController();
        await expect(
            fetchMedia('tok', 'media/u/abc', ctl.signal),
        ).rejects.toThrow(NetworkError);
    });
});
