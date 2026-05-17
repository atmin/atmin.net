/**
 * Mock the S3 store API (storePresign / storeGet / storeList /
 * storeCompact) and the presigned-PUT fetch interceptor.
 *
 * Usage in a test file:
 *
 *   import { stored, installFetchMock, uninstallFetchMock } from './store-api.mock';
 *
 *   vi.mock('./api', async () => {
 *       const { makeApiMock } = await import('./store-api.mock');
 *       return makeApiMock();
 *   });
 *
 *   beforeEach(() => { stored.clear(); installFetchMock(); });
 *   afterEach(() => { uninstallFetchMock(); });
 */

import { vi } from 'vitest';

// Shared in-memory S3 store — cleared in beforeEach of each consuming test.
export const stored = new Map<string, Uint8Array>();

export async function makeApiMock() {
    const { putWithRetry } =
        await vi.importActual<typeof import('./api')>('./api');
    return {
        putWithRetry,
        storePresign: vi.fn(
            async (_token: string, key: string, _bytes: number) => ({
                presigned_url: `https://s3.example.com/${key}`,
            }),
        ),
        storeGet: vi.fn(async (_token: string, key: string) => {
            const data = stored.get(key);
            if (!data) throw new Error(`key not found: ${key}`);
            return data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength,
            );
        }),
        storeList: vi.fn(async (_token: string, prefix: string) => ({
            keys: [...stored.keys()].filter((k) => k.startsWith(prefix)),
            next_cursor: '',
        })),
        // Mirrors server behaviour: deletes matching live keys and any same-day
        // archives. The merge step is intentionally skipped — omitting it makes
        // wrong call ordering visible as data loss rather than transparent
        // recovery, which is how tests can catch ordering bugs.
        storeCompact: vi.fn(
            async (_token: string, prefix: string, upTo: string) => {
                const boundary = prefix + upTo;
                for (const k of [...stored.keys()]) {
                    if (k.startsWith(prefix) && k <= boundary) stored.delete(k);
                }
                const archiveBase = `${prefix.replace('live/', '')}archive/`;
                const today = new Date().toISOString().slice(0, 10);
                for (const k of [...stored.keys()]) {
                    if (k.startsWith(archiveBase + today)) stored.delete(k);
                }
                return { archived: 0, archive_key: '' };
            },
        ),
    };
}

let _originalFetch: typeof globalThis.fetch;

export function installFetchMock(): void {
    _originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(
        async (url: string | URL | Request, init?: RequestInit) => {
            const urlStr =
                typeof url === 'string'
                    ? url
                    : url instanceof URL
                      ? url.href
                      : (url as Request).url;
            if (init?.method === 'PUT' && init.body) {
                const path = new URL(urlStr).pathname.slice(1);
                const bytes =
                    init.body instanceof Uint8Array
                        ? init.body
                        : new TextEncoder().encode(init.body as string);
                stored.set(path, new Uint8Array(bytes));
            }
            return new Response(null, { status: 200 });
        },
    ) as typeof fetch;
}

export function uninstallFetchMock(): void {
    globalThis.fetch = _originalFetch;
}
