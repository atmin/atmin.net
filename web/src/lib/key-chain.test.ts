import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFetchMock, stored, uninstallFetchMock } from './api.mock';
import { backupEncrypt, deriveKeys, generateBackupSecret } from './crypto';
import { clearBackupKeys, deleteDatabase, getBackupKey } from './db';
import {
    appendChainLink,
    buildChainLink,
    fetchChain,
    type KeyChain,
    resolveBackupKey,
} from './key-chain';
import { path } from './paths';

vi.mock('./api', async () => {
    const { makeApiMock } = await import('./api.mock');
    return makeApiMock();
});

const token = 't';
const userId = 'U_ALICE';

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = FakeIDBKeyRange;
    stored.clear();
    installFetchMock();
});

afterEach(async () => {
    await deleteDatabase();
    uninstallFetchMock();
});

async function deriveExtractable(): Promise<CryptoKey> {
    return (await deriveKeys(generateBackupSecret(), { extractable: true }))
        .backupKey;
}

describe('key-chain build/append/fetch', () => {
    it('fetchChain returns empty when key_chain.json is absent', async () => {
        const chain = await fetchChain(token, userId);
        expect(chain.links).toEqual([]);
    });

    it('appendChainLink writes a JSON blob at the expected path', async () => {
        const link = {
            from: 1,
            to: 2,
            iv: 'aXY=',
            ciphertext: 'Y3Q=',
        };
        await appendChainLink(token, userId, link);
        const blob = stored.get(path.keyChain(userId));
        expect(blob).toBeDefined();
        const parsed = JSON.parse(
            new TextDecoder().decode(blob as Uint8Array),
        ) as KeyChain;
        expect(parsed.links).toEqual([link]);
    });

    it('appendChainLink extends an existing chain', async () => {
        await appendChainLink(token, userId, {
            from: 1,
            to: 2,
            iv: 'a',
            ciphertext: 'b',
        });
        await appendChainLink(token, userId, {
            from: 2,
            to: 3,
            iv: 'c',
            ciphertext: 'd',
        });
        const chain = await fetchChain(token, userId);
        expect(chain.links.map((l) => [l.from, l.to])).toEqual([
            [1, 2],
            [2, 3],
        ]);
    });

    it('buildChainLink + decrypt with toKey recovers the prevKey bytes', async () => {
        const prev = await deriveExtractable();
        const next = await deriveExtractable();
        const prevRaw = new Uint8Array(
            await crypto.subtle.exportKey('raw', prev),
        );

        const link = await buildChainLink(1, 2, prev, next);
        const iv = Uint8Array.from(atob(link.iv), (c) => c.charCodeAt(0));
        const ct = Uint8Array.from(atob(link.ciphertext), (c) =>
            c.charCodeAt(0),
        );
        const recovered = new Uint8Array(
            await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, next, ct),
        );
        expect(recovered).toEqual(prevRaw);
    });
});

describe('resolveBackupKey', () => {
    async function makeChain(
        secrets: Uint8Array[],
    ): Promise<{ keys: CryptoKey[]; chain: KeyChain }> {
        // keys[i] is the key for version i+1.
        const keys: CryptoKey[] = [];
        for (const s of secrets) {
            keys.push((await deriveKeys(s, { extractable: true })).backupKey);
        }
        const links = [];
        for (let i = 1; i < keys.length; i++) {
            links.push(await buildChainLink(i, i + 1, keys[i - 1], keys[i]));
        }
        return { keys, chain: { links } };
    }

    it('returns the current key when target === current', async () => {
        const { keys, chain } = await makeChain([generateBackupSecret()]);
        const got = await resolveBackupKey(userId, keys[0], 1, 1, chain);
        expect(got).toBe(keys[0]);
    });

    it('throws when target > current', async () => {
        const { keys, chain } = await makeChain([generateBackupSecret()]);
        await expect(
            resolveBackupKey(userId, keys[0], 1, 2, chain),
        ).rejects.toThrow(/newer/);
    });

    it('walks one step (current=2, target=1) and the recovered key decrypts a v1 blob', async () => {
        const { keys, chain } = await makeChain([
            generateBackupSecret(),
            generateBackupSecret(),
        ]);
        // Encrypt a payload with key v1 (the older), then recover v1 via chain.
        const payload = new TextEncoder().encode('hello v1');
        const enc = await backupEncrypt(keys[0], payload);

        const recovered = await resolveBackupKey(userId, keys[1], 2, 1, chain);
        const decrypted = new Uint8Array(
            await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: enc.iv as Uint8Array<ArrayBuffer> },
                recovered,
                enc.ciphertext as Uint8Array<ArrayBuffer>,
            ),
        );
        expect(new TextDecoder().decode(decrypted)).toBe('hello v1');
    });

    it('walks two steps (current=3, target=1)', async () => {
        const { keys, chain } = await makeChain([
            generateBackupSecret(),
            generateBackupSecret(),
            generateBackupSecret(),
        ]);
        const payload = new TextEncoder().encode('hello v1 (deep)');
        const enc = await backupEncrypt(keys[0], payload);
        const recovered = await resolveBackupKey(userId, keys[2], 3, 1, chain);
        const decrypted = new Uint8Array(
            await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: enc.iv as Uint8Array<ArrayBuffer> },
                recovered,
                enc.ciphertext as Uint8Array<ArrayBuffer>,
            ),
        );
        expect(new TextDecoder().decode(decrypted)).toBe('hello v1 (deep)');
    });

    it('memoizes the resolved key in IDB; second call hits the memo', async () => {
        const { keys, chain } = await makeChain([
            generateBackupSecret(),
            generateBackupSecret(),
        ]);
        await resolveBackupKey(userId, keys[1], 2, 1, chain);

        // The intermediate key was persisted under (userId, 1).
        const memo = await getBackupKey(userId, 1);
        expect(memo).toBeDefined();

        // Clear chain in-memory and call again — it must still resolve via memo.
        const emptyChain: KeyChain = { links: [] };
        const got = await resolveBackupKey(userId, keys[1], 2, 1, emptyChain);
        expect(got).toBeDefined();
    });

    it('clearBackupKeys empties the memo store', async () => {
        const { keys, chain } = await makeChain([
            generateBackupSecret(),
            generateBackupSecret(),
        ]);
        await resolveBackupKey(userId, keys[1], 2, 1, chain);
        expect(await getBackupKey(userId, 1)).toBeDefined();
        await clearBackupKeys();
        expect(await getBackupKey(userId, 1)).toBeUndefined();
    });

    it('throws a clear error on a broken chain', async () => {
        const { keys } = await makeChain([
            generateBackupSecret(),
            generateBackupSecret(),
            generateBackupSecret(),
        ]);
        // Skip the 1→2 link; only keep 2→3. Resolving target=1 must throw.
        const partial: KeyChain = {
            links: [
                await buildChainLink(2, 3, keys[1], keys[2]),
                // missing { from: 1, to: 2 }
            ],
        };
        await expect(
            resolveBackupKey(userId, keys[2], 3, 1, partial),
        ).rejects.toThrow(/missing link/);
    });
});
