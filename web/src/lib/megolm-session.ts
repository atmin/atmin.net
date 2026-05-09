/**
 * Megolm session manager — central session lifecycle module.
 *
 * Manages outbound (sending) and inbound (receiving) Megolm sessions
 * with IndexedDB persistence via pickle serialization.
 */

import type {
    MegolmInbound,
    MegolmOutbound,
} from '../../crypto/pkg/atmin_crypto';
import {
    clearKeyShares,
    clearOutboundSession,
    hasKeyShare,
    loadInboundSession,
    loadOutboundSession,
    recordKeyShare,
    saveInboundSession,
    saveOutboundSession,
} from './db';
import type { WasmModule } from './wasm';

const ROTATION_THRESHOLD = 100;

export interface SessionManager {
    getOutbound(): Promise<[MegolmOutbound, boolean]>;
    persistOutbound(session: MegolmOutbound): Promise<void>;
    needsRotation(session: MegolmOutbound): boolean;
    rotate(): Promise<MegolmOutbound>;
    addInbound(
        fromUser: string,
        fromDevice: string,
        sessionKeyB64: string,
    ): Promise<[MegolmInbound, boolean]>;
    importInbound(
        sessionId: string,
        fromUser: string,
        fromDevice: string,
        exportedB64: string,
    ): Promise<MegolmInbound>;
    getInbound(sessionId: string): Promise<MegolmInbound | null>;
    persistInbound(sessionId: string): Promise<void>;
    hasSharedWith(sessionId: string, recipientUserId: string): Promise<boolean>;
    recordShare(sessionId: string, recipientUserId: string): Promise<void>;
    destroy(): void;
}

export async function createSessionManager(
    wasm: WasmModule,
    selfUserId?: string,
    selfDeviceId?: string,
    onSessionCreated?: (sessionId: string, sessionKey: string) => Promise<void>,
): Promise<SessionManager> {
    let outbound: MegolmOutbound | null = null;
    let outboundIsNew = false;
    const inboundCache = new Map<string, MegolmInbound>();
    const inboundMeta = new Map<
        string,
        { fromUser: string; fromDevice: string }
    >();

    const mgr: SessionManager = {
        async getOutbound(): Promise<[MegolmOutbound, boolean]> {
            // Return cached
            if (outbound) {
                const isNew = outboundIsNew;
                outboundIsNew = false;
                return [outbound, isNew];
            }

            // Rotate stored session: keep inbound side, create fresh outbound
            const stored = await loadOutboundSession();
            if (stored) {
                const old = wasm.MegolmOutbound.from_pickle(stored.pickleJson);
                if (selfUserId && selfDeviceId) {
                    await mgr.addInbound(
                        selfUserId,
                        selfDeviceId,
                        old.session_key(),
                    );
                }
                await clearKeyShares(old.session_id);
                old.free();
                await clearOutboundSession();
            }

            // Create new
            outbound = new wasm.MegolmOutbound();
            await mgr.persistOutbound(outbound);
            if (selfUserId && selfDeviceId) {
                await mgr.addInbound(
                    selfUserId,
                    selfDeviceId,
                    outbound.session_key(),
                );
            }
            await onSessionCreated?.(
                outbound.session_id,
                outbound.session_key(),
            );
            return [outbound, true];
        },

        async persistOutbound(session: MegolmOutbound): Promise<void> {
            await saveOutboundSession(
                session.session_id,
                session.message_index,
                session.pickle(),
            );
        },

        needsRotation(session: MegolmOutbound): boolean {
            return session.message_index >= ROTATION_THRESHOLD;
        },

        async rotate(): Promise<MegolmOutbound> {
            if (outbound) {
                const oldSessionId = outbound.session_id;
                outbound.free();
                await clearKeyShares(oldSessionId);
            }
            outbound = new wasm.MegolmOutbound();
            await clearOutboundSession();
            await mgr.persistOutbound(outbound);
            if (selfUserId && selfDeviceId) {
                await mgr.addInbound(
                    selfUserId,
                    selfDeviceId,
                    outbound.session_key(),
                );
            }
            await onSessionCreated?.(
                outbound.session_id,
                outbound.session_key(),
            );
            return outbound;
        },

        async addInbound(
            fromUser: string,
            fromDevice: string,
            sessionKeyB64: string,
        ): Promise<[MegolmInbound, boolean]> {
            const session = wasm.MegolmInbound.from_session_key(sessionKeyB64);
            const sessionId = session.session_id;

            // If already cached, free the new one and return existing
            const cached = inboundCache.get(sessionId);
            if (cached) {
                session.free();
                return [cached, false];
            }

            // Check IndexedDB — keep earlier index if it exists
            const stored = await loadInboundSession(sessionId);
            if (stored) {
                session.free();
                const fromDB = wasm.MegolmInbound.from_pickle(
                    stored.pickleJson,
                );
                inboundCache.set(sessionId, fromDB);
                inboundMeta.set(sessionId, {
                    fromUser: stored.fromUser,
                    fromDevice: stored.fromDevice,
                });
                return [fromDB, false];
            }

            inboundCache.set(sessionId, session);
            inboundMeta.set(sessionId, { fromUser, fromDevice });
            await saveInboundSession(
                sessionId,
                fromUser,
                fromDevice,
                session.pickle(),
            );
            return [session, true];
        },

        async importInbound(
            sessionId: string,
            fromUser: string,
            fromDevice: string,
            exportedB64: string,
        ): Promise<MegolmInbound> {
            const existing = inboundCache.get(sessionId);
            if (existing) return existing;

            const session = wasm.MegolmInbound.from_export(exportedB64);
            inboundCache.set(sessionId, session);
            inboundMeta.set(sessionId, { fromUser, fromDevice });
            await saveInboundSession(
                sessionId,
                fromUser,
                fromDevice,
                session.pickle(),
            );
            return session;
        },

        async getInbound(sessionId: string): Promise<MegolmInbound | null> {
            // Check cache
            const cached = inboundCache.get(sessionId);
            if (cached) return cached;

            // Try loading from IndexedDB
            const stored = await loadInboundSession(sessionId);
            if (!stored) return null;

            const session = wasm.MegolmInbound.from_pickle(stored.pickleJson);
            inboundCache.set(sessionId, session);
            inboundMeta.set(sessionId, {
                fromUser: stored.fromUser,
                fromDevice: stored.fromDevice,
            });
            return session;
        },

        async persistInbound(sessionId: string): Promise<void> {
            const session = inboundCache.get(sessionId);
            const meta = inboundMeta.get(sessionId);
            if (!session || !meta) return;
            await saveInboundSession(
                sessionId,
                meta.fromUser,
                meta.fromDevice,
                session.pickle(),
            );
        },

        async hasSharedWith(
            sessionId: string,
            recipientUserId: string,
        ): Promise<boolean> {
            return hasKeyShare(sessionId, recipientUserId);
        },

        async recordShare(
            sessionId: string,
            recipientUserId: string,
        ): Promise<void> {
            await recordKeyShare(sessionId, recipientUserId);
        },

        destroy(): void {
            if (outbound) {
                outbound.free();
                outbound = null;
            }
            for (const session of inboundCache.values()) {
                session.free();
            }
            inboundCache.clear();
        },
    };

    // Eagerly rotate outbound on app start + register self-inbound
    // so fetchMessages can decrypt self-copies before any send
    if (selfUserId && selfDeviceId) {
        const stored = await loadOutboundSession();
        if (stored) {
            // Keep old session's inbound side for decrypting previous messages
            const old = wasm.MegolmOutbound.from_pickle(stored.pickleJson);
            await mgr.addInbound(selfUserId, selfDeviceId, old.session_key());
            await clearKeyShares(old.session_id);
            old.free();
            // Create fresh outbound session
            await clearOutboundSession();
            outbound = new wasm.MegolmOutbound();
            await mgr.persistOutbound(outbound);
            await mgr.addInbound(
                selfUserId,
                selfDeviceId,
                outbound.session_key(),
            );
            await onSessionCreated?.(
                outbound.session_id,
                outbound.session_key(),
            );
            outboundIsNew = true;
        }
    }

    return mgr;
}
