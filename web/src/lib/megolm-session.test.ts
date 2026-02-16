import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    MegolmInbound,
    MegolmOutbound,
} from '../../crypto/pkg-node/atmin_crypto.js';
import {
    clearInboundSessions,
    clearKeyShares,
    clearMessages,
    clearOutboundSession,
} from './db';
import { createSessionManager } from './megolm-session';
import type { WasmModule } from './wasm';

const wasm: WasmModule = {
    MegolmOutbound: MegolmOutbound as unknown as WasmModule['MegolmOutbound'],
    MegolmInbound: MegolmInbound as unknown as WasmModule['MegolmInbound'],
};

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = FakeIDBKeyRange;
});

afterEach(async () => {
    await clearOutboundSession();
    await clearInboundSessions();
    await clearKeyShares();
    await clearMessages();
});

describe('SessionManager', () => {
    describe('outbound', () => {
        it('creates new session on first call', async () => {
            const mgr = await createSessionManager(wasm);
            const [session, isNew] = await mgr.getOutbound();

            expect(isNew).toBe(true);
            expect(session.session_id).toBeTruthy();
            expect(session.message_index).toBe(0);

            mgr.destroy();
        });

        it('returns same session on second call', async () => {
            const mgr = await createSessionManager(wasm);
            const [s1] = await mgr.getOutbound();
            const [s2, isNew] = await mgr.getOutbound();

            expect(isNew).toBe(false);
            expect(s2.session_id).toBe(s1.session_id);

            mgr.destroy();
        });

        it('rotates session on new manager instance (app restart)', async () => {
            const mgr1 = await createSessionManager(wasm);
            const [session1] = await mgr1.getOutbound();
            const oldSessionId = session1.session_id;

            // Encrypt some messages and persist
            session1.encrypt('hello');
            session1.encrypt('world');
            await mgr1.persistOutbound(session1);
            mgr1.destroy();

            // New manager instance (simulates page reload)
            const mgr2 = await createSessionManager(wasm);
            const [session2, isNew] = await mgr2.getOutbound();

            expect(isNew).toBe(true);
            expect(session2.session_id).not.toBe(oldSessionId);
            expect(session2.message_index).toBe(0);

            mgr2.destroy();
        });

        it('detects rotation threshold', async () => {
            const mgr = await createSessionManager(wasm);
            const [session] = await mgr.getOutbound();

            expect(mgr.needsRotation(session)).toBe(false);

            // Encrypt 100 messages to reach rotation threshold
            for (let i = 0; i < 100; i++) {
                session.encrypt(`msg ${i}`);
            }

            expect(mgr.needsRotation(session)).toBe(true);

            mgr.destroy();
        });

        it('rotation creates new session and clears old key shares', async () => {
            const mgr = await createSessionManager(wasm);
            const [session1] = await mgr.getOutbound();
            const oldId = session1.session_id;

            await mgr.recordShare(oldId, 'bob01');
            expect(await mgr.hasSharedWith(oldId, 'bob01')).toBe(true);

            const session2 = await mgr.rotate();
            expect(session2.session_id).not.toBe(oldId);
            expect(session2.message_index).toBe(0);

            // Old key shares should be cleared
            expect(await mgr.hasSharedWith(oldId, 'bob01')).toBe(false);

            mgr.destroy();
        });
    });

    describe('inbound', () => {
        it('adds and retrieves inbound session', async () => {
            const mgr = await createSessionManager(wasm);
            const sender = new MegolmOutbound();
            const sessionKey = sender.session_key();

            const inbound = await mgr.addInbound('bob01', 'bdev01', sessionKey);

            expect(inbound.session_id).toBe(sender.session_id);

            // Retrieve by sessionId
            const retrieved = await mgr.getInbound(sender.session_id);
            expect(retrieved).not.toBeNull();
            expect(retrieved?.session_id).toBe(sender.session_id);

            sender.free();
            mgr.destroy();
        });

        it('returns null for unknown session', async () => {
            const mgr = await createSessionManager(wasm);
            const result = await mgr.getInbound('unknown-session');
            expect(result).toBeNull();
            mgr.destroy();
        });

        it('persists inbound across manager instances', async () => {
            const sender = new MegolmOutbound();
            const sessionKey = sender.session_key();

            const mgr1 = await createSessionManager(wasm);
            await mgr1.addInbound('bob01', 'bdev01', sessionKey);
            mgr1.destroy();

            // New manager (simulated reload)
            const mgr2 = await createSessionManager(wasm);
            const restored = await mgr2.getInbound(sender.session_id);
            expect(restored).not.toBeNull();
            expect(restored?.session_id).toBe(sender.session_id);

            // Can decrypt messages
            const ct = sender.encrypt('test message');
            expect(restored?.decrypt(ct)).toBe('test message');

            sender.free();
            mgr2.destroy();
        });

        it('addInbound is idempotent', async () => {
            const mgr = await createSessionManager(wasm);
            const sender = new MegolmOutbound();
            const sessionKey = sender.session_key();

            const s1 = await mgr.addInbound('bob01', 'bdev01', sessionKey);
            const s2 = await mgr.addInbound('bob01', 'bdev01', sessionKey);

            // Should return same cached instance
            expect(s1).toBe(s2);

            sender.free();
            mgr.destroy();
        });

        it('imports from exported key (key backup)', async () => {
            const sender = new MegolmOutbound();
            const receiver = MegolmInbound.from_session_key(
                sender.session_key(),
            );
            const exported = receiver.export_at_first_known_index();
            receiver.free();

            const mgr = await createSessionManager(wasm);
            const imported = await mgr.importInbound(
                sender.session_id,
                'bob01',
                'bdev01',
                exported,
            );

            const ct = sender.encrypt('from backup');
            expect(imported.decrypt(ct)).toBe('from backup');

            sender.free();
            mgr.destroy();
        });
    });

    describe('key shares', () => {
        it('tracks shares per session and recipient', async () => {
            const mgr = await createSessionManager(wasm);

            expect(await mgr.hasSharedWith('S1', 'bob01')).toBe(false);

            await mgr.recordShare('S1', 'bob01');
            expect(await mgr.hasSharedWith('S1', 'bob01')).toBe(true);
            expect(await mgr.hasSharedWith('S1', 'alice01')).toBe(false);

            mgr.destroy();
        });
    });
});
