import { encode as cborEncode } from 'cbor-x';
import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    derive_secret,
    MegolmInbound,
    MegolmOutbound,
} from '../../crypto/pkg-node/atmin_crypto.js';
import { storeCompact } from './api';
import { installFetchMock, stored, uninstallFetchMock } from './api.mock';
import {
    backupDecrypt,
    backupEncrypt,
    deriveKeys,
    generateBackupSecret,
} from './crypto';
import { deleteDatabase } from './db';
import { createSessionManager } from './megolm-session';
import type { WasmModule } from './wasm';

vi.mock('./api', async () => {
    const { makeApiMock } = await import('./api.mock');
    return makeApiMock();
});

const wasm: WasmModule = {
    MegolmOutbound: MegolmOutbound as unknown as WasmModule['MegolmOutbound'],
    MegolmInbound: MegolmInbound as unknown as WasmModule['MegolmInbound'],
    derive_secret,
};

const token = 'test-token';
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

async function makeBackupKey(): Promise<CryptoKey> {
    return (await deriveKeys(generateBackupSecret())).backupKey;
}

describe('backupSessionKey retry', () => {
    it('retries PUT once on 503 then resolves', async () => {
        const { backupSessionKey } = await import('./key-backup');
        const backupKey = await makeBackupKey();
        const sender = new MegolmOutbound();

        let putCalls = 0;
        globalThis.fetch = vi.fn(async (_url, init) => {
            if ((init as RequestInit)?.method === 'PUT') {
                putCalls++;
                return new Response(null, {
                    status: putCalls < 2 ? 503 : 200,
                });
            }
            return new Response(null, { status: 200 });
        }) as typeof fetch;

        await backupSessionKey(
            token,
            userId,
            sender.session_id,
            sender.session_key(),
            backupKey,
            1,
        );
        expect(putCalls).toBe(2);

        sender.free();
    });

    it('rejects when PUT returns 503 twice', async () => {
        const { backupSessionKey } = await import('./key-backup');
        const backupKey = await makeBackupKey();
        const sender = new MegolmOutbound();

        globalThis.fetch = vi.fn(
            async () => new Response(null, { status: 503 }),
        ) as typeof fetch;

        await expect(
            backupSessionKey(
                token,
                userId,
                sender.session_id,
                sender.session_key(),
                backupKey,
                1,
            ),
        ).rejects.toThrow();

        sender.free();
    });
});

describe('backupSessionKey', () => {
    it('uploads encrypted key to keys/{userId}/live/{sessionId}', async () => {
        const { backupSessionKey } = await import('./key-backup');
        const backupKey = await makeBackupKey();
        const sender = new MegolmOutbound();
        const sessionKey = sender.session_key();
        const sessionId = sender.session_id;

        await backupSessionKey(
            token,
            userId,
            sessionId,
            sessionKey,
            backupKey,
            1,
        );

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
        await backupSessionKey(
            token,
            userId,
            sessionId,
            sessionKey,
            backupKey,
            1,
        );

        // Simulate Device B: fresh IDB, restore from backup
        globalThis.indexedDB = new IDBFactory();
        const freshMgr = await createSessionManager(wasm);
        const restored = await restoreSessionKeys(
            token,
            userId,
            backupKey,
            1,
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
            1,
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
            1,
        );

        const mgr = await createSessionManager(wasm);
        const first = await restoreSessionKeys(
            token,
            userId,
            backupKey,
            1,
            mgr,
        );
        const second = await restoreSessionKeys(
            token,
            userId,
            backupKey,
            1,
            mgr,
        );

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
            1,
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
            1,
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
            1,
            mgr,
        );
        expect(restored).toBe(0);

        mgr.destroy();
    });

    it('restores sessions from a same-day archive even when live keys trigger compaction', async () => {
        const { backupSessionKey, restoreSessionKeys } = await import(
            './key-backup'
        );
        const backupKey = await makeBackupKey();

        // Session A: in live — its presence sets hadLiveKeys and triggers compact
        const senderA = new MegolmOutbound();
        await backupSessionKey(
            token,
            userId,
            senderA.session_id,
            senderA.session_key(),
            backupKey,
            1,
        );

        // Session B: only in a same-day archive — exactly what compact deletes.
        // If compact fires before the archive loop, B is silently lost.
        const senderB = new MegolmOutbound();
        const { iv, ciphertext: encCt } = await backupEncrypt(
            backupKey,
            new TextEncoder().encode(senderB.session_key()),
        );
        const today = new Date().toISOString().slice(0, 10);
        stored.set(
            `keys/${userId}/archive/${today}-PRIOR`,
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
            1,
            freshMgr,
        );

        expect(restored).toBe(2);
        expect(await freshMgr.getInbound(senderA.session_id)).not.toBeNull();
        expect(await freshMgr.getInbound(senderB.session_id)).not.toBeNull();

        senderA.free();
        senderB.free();
        freshMgr.destroy();
    });

    it('fires compaction after restoring live keys', async () => {
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
            1,
        );

        const mgr = await createSessionManager(wasm);
        vi.mocked(storeCompact).mockClear();
        await restoreSessionKeys(token, userId, backupKey, 1, mgr);

        expect(vi.mocked(storeCompact)).toHaveBeenCalledOnce();
        expect(vi.mocked(storeCompact)).toHaveBeenCalledWith(
            token,
            `keys/${userId}/live/`,
            '~',
        );

        sender.free();
        mgr.destroy();
    });

    it('skips compaction when there are no live keys', async () => {
        // Real-world: new account (getOutbound never called yet) or new-device
        // restore. createSessionManager's eager rotation only fires when an
        // existing outbound session is in IDB, so neither case produces a live
        // key. Compact must not fire — it would be a pointless server round-trip.
        const { restoreSessionKeys } = await import('./key-backup');
        const backupKey = await makeBackupKey();

        const mgr = await createSessionManager(wasm);
        vi.mocked(storeCompact).mockClear();
        await restoreSessionKeys(token, userId, backupKey, 1, mgr);

        expect(vi.mocked(storeCompact)).not.toHaveBeenCalled();

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
            1,
        );

        // Poison a second key: storeGet will throw for it
        stored.set(`keys/${userId}/live/ghost-session`, new Uint8Array(0));

        const mgr = await createSessionManager(wasm);
        // Should restore senderA and skip the corrupt entry, not throw
        const restored = await restoreSessionKeys(
            token,
            userId,
            backupKey,
            1,
            mgr,
        );

        expect(restored).toBe(1);
        expect(await mgr.getInbound(senderA.session_id)).not.toBeNull();

        senderA.free();
        mgr.destroy();
    });
});

describe('versioned envelopes + chain walking', () => {
    it('writes a v2-shaped envelope when keyVersion = 2', async () => {
        const { backupSessionKey } = await import('./key-backup');
        const backupKey = await makeBackupKey();
        const sender = new MegolmOutbound();

        await backupSessionKey(
            token,
            userId,
            sender.session_id,
            sender.session_key(),
            backupKey,
            2,
        );

        const blob = stored.get(`keys/${userId}/live/${sender.session_id}`);
        const raw = JSON.parse(new TextDecoder().decode(blob as Uint8Array));
        expect(raw.v).toBe(2);
        expect(raw.session_id).toBe(sender.session_id);
        expect(raw.msg_id).toBe(sender.session_id);

        sender.free();
    });

    it('restores a v1 legacy-shape live blob on a current=v1 account', async () => {
        const { restoreSessionKeys } = await import('./key-backup');
        const backupKey = await makeBackupKey();
        const sender = new MegolmOutbound();
        const sessionKey = sender.session_key();
        const sessionId = sender.session_id;
        const ciphertext = sender.encrypt('legacy live');

        const { iv, ciphertext: ct } = await backupEncrypt(
            backupKey,
            new TextEncoder().encode(sessionKey),
        );
        const legacy = JSON.stringify({
            msg_id: sessionId,
            session_id: sessionId,
            iv: btoa(String.fromCharCode(...iv)),
            ciphertext: btoa(String.fromCharCode(...ct)),
        });
        stored.set(
            `keys/${userId}/live/${sessionId}`,
            new TextEncoder().encode(legacy),
        );

        const mgr = await createSessionManager(wasm);
        const restored = await restoreSessionKeys(
            token,
            userId,
            backupKey,
            1,
            mgr,
        );
        expect(restored).toBe(1);
        const session = await mgr.getInbound(sessionId);
        expect(session?.decrypt(ciphertext)).toBe('legacy live');

        sender.free();
        mgr.destroy();
    });

    it('walks the chain to restore a v1 blob on a current=v2 account', async () => {
        const { backupSessionKey, restoreSessionKeys } = await import(
            './key-backup'
        );
        const { buildChainLink, appendChainLink } = await import('./key-chain');

        const v1Key = (
            await deriveKeys(generateBackupSecret(), { extractable: true })
        ).backupKey;
        const v2Key = (
            await deriveKeys(generateBackupSecret(), { extractable: true })
        ).backupKey;

        // Pre-existing v1 blob written under the old key. Snapshot
        // session_key BEFORE the first encrypt — the Megolm ratchet
        // advances on every encrypt and a later snapshot can't decrypt
        // earlier messages.
        const sender = new MegolmOutbound();
        const v1SessionId = sender.session_id;
        const v1SessionKey = sender.session_key();
        const ciphertextV1 = sender.encrypt('encrypted under v1');
        const v1Enc = await backupEncrypt(
            v1Key,
            new TextEncoder().encode(v1SessionKey),
        );
        stored.set(
            `keys/${userId}/live/${v1SessionId}`,
            new TextEncoder().encode(
                JSON.stringify({
                    v: 1,
                    msg_id: v1SessionId,
                    session_id: v1SessionId,
                    iv: btoa(String.fromCharCode(...v1Enc.iv)),
                    ciphertext: btoa(String.fromCharCode(...v1Enc.ciphertext)),
                }),
            ),
        );

        // Fresh v2 blob via the production write path.
        const sender2 = new MegolmOutbound();
        const v2SessionId = sender2.session_id;
        const v2SessionKey = sender2.session_key();
        const ciphertextV2 = sender2.encrypt('encrypted under v2');
        await backupSessionKey(
            token,
            userId,
            v2SessionId,
            v2SessionKey,
            v2Key,
            2,
        );

        await appendChainLink(
            token,
            userId,
            await buildChainLink(1, 2, v1Key, v2Key),
        );

        const mgr = await createSessionManager(wasm);
        const restored = await restoreSessionKeys(token, userId, v2Key, 2, mgr);
        expect(restored).toBe(2);

        const s1 = await mgr.getInbound(v1SessionId);
        expect(s1?.decrypt(ciphertextV1)).toBe('encrypted under v1');
        const s2 = await mgr.getInbound(v2SessionId);
        expect(s2?.decrypt(ciphertextV2)).toBe('encrypted under v2');

        sender.free();
        sender2.free();
        mgr.destroy();
    });

    it('decrypts a mixed-version archive (v1 + v2 entries in one CBOR blob)', async () => {
        const { restoreSessionKeys } = await import('./key-backup');
        const { buildChainLink, appendChainLink } = await import('./key-chain');

        const v1Key = (
            await deriveKeys(generateBackupSecret(), { extractable: true })
        ).backupKey;
        const v2Key = (
            await deriveKeys(generateBackupSecret(), { extractable: true })
        ).backupKey;

        const sA = new MegolmOutbound();
        const sB = new MegolmOutbound();
        const sAKey = sA.session_key();
        const sBKey = sB.session_key();
        const ctA = sA.encrypt('alpha');
        const ctB = sB.encrypt('beta');

        const encA = await backupEncrypt(
            v1Key,
            new TextEncoder().encode(sAKey),
        );
        const encB = await backupEncrypt(
            v2Key,
            new TextEncoder().encode(sBKey),
        );
        const archive = [
            {
                v: 1,
                msg_id: sA.session_id,
                session_id: sA.session_id,
                iv: btoa(String.fromCharCode(...encA.iv)),
                ciphertext: btoa(String.fromCharCode(...encA.ciphertext)),
            },
            {
                v: 2,
                msg_id: sB.session_id,
                session_id: sB.session_id,
                iv: btoa(String.fromCharCode(...encB.iv)),
                ciphertext: btoa(String.fromCharCode(...encB.ciphertext)),
            },
        ];
        stored.set(
            `keys/${userId}/archive/2025-01-01-MIXEDARCHIVE`,
            new Uint8Array(cborEncode(archive)),
        );
        await appendChainLink(
            token,
            userId,
            await buildChainLink(1, 2, v1Key, v2Key),
        );

        const mgr = await createSessionManager(wasm);
        const restored = await restoreSessionKeys(token, userId, v2Key, 2, mgr);
        expect(restored).toBe(2);
        expect((await mgr.getInbound(sA.session_id))?.decrypt(ctA)).toBe(
            'alpha',
        );
        expect((await mgr.getInbound(sB.session_id))?.decrypt(ctB)).toBe(
            'beta',
        );

        sA.free();
        sB.free();
        mgr.destroy();
    });
});
