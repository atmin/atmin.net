/**
 * Megolm session manager — central session lifecycle module.
 *
 * Manages outbound (sending) and inbound (receiving) Megolm sessions
 * with IndexedDB persistence via pickle serialization.
 */

import type { MegolmInbound, MegolmOutbound } from '../crypto/pkg/atmin_crypto';
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
    ): Promise<MegolmInbound>;
    importInbound(
        sessionId: string,
        fromUser: string,
        fromDevice: string,
        exportedB64: string,
    ): Promise<MegolmInbound>;
    getInbound(sessionId: string): Promise<MegolmInbound | null>;
    hasSharedWith(sessionId: string, recipientUserId: string): Promise<boolean>;
    recordShare(sessionId: string, recipientUserId: string): Promise<void>;
    destroy(): void;
}

export function createSessionManager(wasm: WasmModule): SessionManager {
    let outbound: MegolmOutbound | null = null;
    const inboundCache = new Map<string, MegolmInbound>();

    return {
        async getOutbound(): Promise<[MegolmOutbound, boolean]> {
            // Return cached
            if (outbound) return [outbound, false];

            // Try loading from IndexedDB
            const stored = await loadOutboundSession();
            if (stored) {
                outbound = wasm.MegolmOutbound.from_pickle(stored.pickleJson);
                return [outbound, false];
            }

            // Create new
            outbound = new wasm.MegolmOutbound();
            await this.persistOutbound(outbound);
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
            await this.persistOutbound(outbound);
            return outbound;
        },

        async addInbound(
            fromUser: string,
            fromDevice: string,
            sessionKeyB64: string,
        ): Promise<MegolmInbound> {
            const session = wasm.MegolmInbound.from_session_key(sessionKeyB64);
            const sessionId = session.session_id;

            // If already cached, free the new one and return existing
            const existing = inboundCache.get(sessionId);
            if (existing) {
                session.free();
                return existing;
            }

            inboundCache.set(sessionId, session);
            await saveInboundSession(
                sessionId,
                fromUser,
                fromDevice,
                session.pickle(),
            );
            return session;
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
            return session;
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
}
