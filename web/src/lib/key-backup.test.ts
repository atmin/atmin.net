import { encode as cborEncode } from 'cbor-x';
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MegolmInbound,
    MegolmOutbound,
} from '../../crypto/pkg-node/atmin_crypto.js';
import {
    backupDecrypt,
    backupEncrypt,
    deriveKeys,
    generateBackupSecret,
} from './crypto';
import { deleteDatabase } from './db';
import { createSessionManager } from './megolm-session';
import type { WasmModule } from './wasm';

// In-memory store: captures presigned PUT bodies, serves them via storeGet,
// and lists them via storeList.
const stored = new Map<string, Uint8Array>();

vi.mock('./api', () => ({
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
}));

const wasm: WasmModule = {
    MegolmOutbound: MegolmOutbound as unknown as WasmModule['MegolmOutbound'],
    MegolmInbound: MegolmInbound as unknown as WasmModule['MegolmInbound'],
};

const token = 'test-token';
const userId = 'U_ALICE';

const originalFetch = globalThis.fetch;

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = FakeIDBKeyRange;
    stored.clear();

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
});

afterEach(async () => {
    await deleteDatabase();
    globalThis.fetch = originalFetch;
});

async function makeBackupKey(): Promise<CryptoKey> {
    return (await deriveKeys(generateBackupSecret())).backupKey;
}

describe('backupSessionKey', () => {
    it('uploads encrypted key to keys/{userId}/live/{sessionId}', async () => {
        const { backupSessionKey } = await import('./key-backup');
        const backupKey = await makeBackupKey();
        const sender = new MegolmOutbound();
        const sessionKey = sender.session_key();
        const sessionId = sender.session_id;

        await backupSessionKey(token, userId, sessionId, sessionKey, backupKey);

        const expectedPath = `keys/${userId}/live/${sessionId}`;
        expect(stored.has(expectedPath)).toBe(true);

        const raw = JSON.parse(
            new TextDecoder().decode(stored.get(expectedPath)),
        );
        expect(raw.session_id).toBe(sessionId);

        const iv = Uint8Array.from(atob(raw.iv), (c) => c.charCodeAt(0));
        const ct = Uint8Array.from(atob(raw.ciphertext), (c) =>
            c.charCodeAt(0),
        );
        const decrypted = await backupDecrypt(backupKey, {
            iv,
            ciphertext: ct,
        });
        expect(new TextDecoder().decode(decrypted)).toBe(sessionKey);

        sender.free();
    });
});

describe('restoreSessionKeys', () => {
    it('restores from live prefix and can decrypt messages', async () => {
        const { backupSessionKey, restoreSessionKeys } = await import(
            './key-backup'
        );
        const backupKey = await makeBackupKey();

        // Simulate Device A: create a session, encrypt a message, back up the key
        const sender = new MegolmOutbound();
        const sessionKey = sender.session_key();
        const sessionId = sender.session_id;
        const ciphertext = sender.encrypt('secret message');
        await backupSessionKey(token, userId, sessionId, sessionKey, backupKey);

        // Simulate Device B: fresh IDB, restore from backup
        globalThis.indexedDB = new IDBFactory();
        const freshMgr = await createSessionManager(wasm);
        const restored = await restoreSessionKeys(
            token,
            userId,
            backupKey,
            freshMgr,
        );

        expect(restored).toBe(1);
        const session = await freshMgr.getInbound(sessionId);
        expect(session).not.toBeNull();
        expect(session?.decrypt(ciphertext)).toBe('secret message');

        sender.free();
        freshMgr.destroy();
    });

    it('restores from archive CBOR and can decrypt messages', async () => {
        const { restoreSessionKeys } = await import('./key-backup');
        const backupKey = await makeBackupKey();

        const sender = new MegolmOutbound();
        const sessionKey = sender.session_key();
        const sessionId = sender.session_id;
        const ciphertext = sender.encrypt('archived message');

        // Manually create a CBOR archive blob (simulates compacted key backup)
        const { iv, ciphertext: encCt } = await backupEncrypt(
            backupKey,
            new TextEncoder().encode(sessionKey),
        );
        const entry = {
            msg_id: sessionId,
            session_id: sessionId,
            iv: btoa(String.fromCharCode(...iv)),
            ciphertext: btoa(String.fromCharCode(...encCt)),
        };
        const archiveKey = `keys/${userId}/archive/2025-01-01-TESTARCHIVE`;
        stored.set(archiveKey, new Uint8Array(cborEncode([entry])));

        const freshMgr = await createSessionManager(wasm);
        const restored = await restoreSessionKeys(
            token,
            userId,
            backupKey,
            freshMgr,
        );

        expect(restored).toBe(1);
        const session = await freshMgr.getInbound(sessionId);
        expect(session).not.toBeNull();
        expect(session?.decrypt(ciphertext)).toBe('archived message');

        sender.free();
        freshMgr.destroy();
    });

    it('is idempotent — second restore call returns 0 for already-known sessions', async () => {
        const { backupSessionKey, restoreSessionKeys } = await import(
            './key-backup'
        );
        const backupKey = await makeBackupKey();

        const sender = new MegolmOutbound();
        await backupSessionKey(
            token,
            userId,
            sender.session_id,
            sender.session_key(),
            backupKey,
        );

        const mgr = await createSessionManager(wasm);
        const first = await restoreSessionKeys(token, userId, backupKey, mgr);
        const second = await restoreSessionKeys(token, userId, backupKey, mgr);

        expect(first).toBe(1);
        expect(second).toBe(0);

        sender.free();
        mgr.destroy();
    });

    it('restores multiple sessions from live and archive together', async () => {
        const { backupSessionKey, restoreSessionKeys } = await import(
            './key-backup'
        );
        const backupKey = await makeBackupKey();

        // Live: session A
        const senderA = new MegolmOutbound();
        await backupSessionKey(
            token,
            userId,
            senderA.session_id,
            senderA.session_key(),
            backupKey,
        );

        // Archive: session B
        const senderB = new MegolmOutbound();
        const { iv, ciphertext: encCt } = await backupEncrypt(
            backupKey,
            new TextEncoder().encode(senderB.session_key()),
        );
        stored.set(
            `keys/${userId}/archive/2025-01-01-ARCHIVEB`,
            new Uint8Array(
                cborEncode([
                    {
                        msg_id: senderB.session_id,
                        session_id: senderB.session_id,
                        iv: btoa(String.fromCharCode(...iv)),
                        ciphertext: btoa(String.fromCharCode(...encCt)),
                    },
                ]),
            ),
        );

        globalThis.indexedDB = new IDBFactory();
        const freshMgr = await createSessionManager(wasm);
        const restored = await restoreSessionKeys(
            token,
            userId,
            backupKey,
            freshMgr,
        );

        expect(restored).toBe(2);
        expect(await freshMgr.getInbound(senderA.session_id)).not.toBeNull();
        expect(await freshMgr.getInbound(senderB.session_id)).not.toBeNull();

        senderA.free();
        senderB.free();
        freshMgr.destroy();
    });

    it('returns 0 when keys/ prefix is empty (new account with no backups)', async () => {
        const { restoreSessionKeys } = await import('./key-backup');
        const backupKey = await makeBackupKey();

        const mgr = await createSessionManager(wasm);
        const restored = await restoreSessionKeys(
            token,
            userId,
            backupKey,
            mgr,
        );
        expect(restored).toBe(0);

        mgr.destroy();
    });

    it('survives a missing live key without aborting (partial restore)', async () => {
        const { backupSessionKey, restoreSessionKeys } = await import(
            './key-backup'
        );
        const backupKey = await makeBackupKey();

        const senderA = new MegolmOutbound();
        await backupSessionKey(
            token,
            userId,
            senderA.session_id,
            senderA.session_key(),
            backupKey,
        );

        // Poison a second key: storeGet will throw for it
        stored.set(`keys/${userId}/live/ghost-session`, new Uint8Array(0));

        const mgr = await createSessionManager(wasm);
        // Should restore senderA and skip the corrupt entry, not throw
        const restored = await restoreSessionKeys(
            token,
            userId,
            backupKey,
            mgr,
        );

        expect(restored).toBe(1);
        expect(await mgr.getInbound(senderA.session_id)).not.toBeNull();

        senderA.free();
        mgr.destroy();
    });
});
