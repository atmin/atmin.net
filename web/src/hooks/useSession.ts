import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteDevice, onAuthEvent } from '@/lib/api';
import {
    clearSession,
    clearToken,
    loadSession,
    type Session,
} from '@/lib/auth';
import { restoreContacts } from '@/lib/contact-backup';
import { restoreSessionKeys } from '@/lib/key-backup';
import type { SessionManager } from '@/lib/megolm-session';

export type LoginNotice = 'rotated_elsewhere' | null;

export interface SessionState {
    session: Session | null;
    sessionManager: SessionManager | null;
    loading: boolean;
    notice: LoginNotice;
    handleLogin: (session: Session) => void;
    handleLogout: () => Promise<void>;
    clearNotice: () => void;
}

export function useSession(): SessionState {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const [notice, setNotice] = useState<LoginNotice>(null);
    const [sessionManager, setSessionManager] = useState<SessionManager | null>(
        null,
    );

    useEffect(() => {
        loadSession()
            .then(setSession)
            .finally(() => setLoading(false));
    }, []);

    // Init WASM + session manager when session is available.
    // Depend on stable primitives rather than the session object itself,
    // which gets a new reference on every loadSession() call.
    // This prevents React StrictMode's double-invocation from spawning
    // two concurrent createSessionManager calls that race on IndexedDB.
    const userId = session?.userId ?? null;
    const deviceId = session?.deviceId ?? null;
    const token = session?.token ?? null;
    const backupKey = session?.backupKey ?? null;
    const keyVersion = session?.keyVersion ?? 1;
    useEffect(() => {
        if (!userId || !deviceId || !token || !backupKey) return;

        let cancelled = false;

        (async () => {
            const { loadWasm } = await import('@/lib/wasm');
            if (cancelled) return;
            const { createSessionManager } = await import(
                '@/lib/megolm-session'
            );
            if (cancelled) return;
            const { backupSessionKey } = await import('@/lib/key-backup');
            if (cancelled) return;
            const wasm = await loadWasm();
            if (cancelled) return;
            const mgr = await createSessionManager(
                wasm,
                userId,
                deviceId,
                (sessionId, sessionKey) =>
                    backupSessionKey(
                        token,
                        userId,
                        sessionId,
                        sessionKey,
                        backupKey,
                        keyVersion,
                    ).catch((err) => console.error('Key backup failed:', err)),
            );
            if (cancelled) return;

            // Restore inbound session keys before first sync (see docs/scenarios/account-recovery.md).
            // Pass currentVersion so blobs written under an older kv get
            // decrypted via the chain walker (ADR-0012).
            try {
                await restoreSessionKeys(
                    token,
                    userId,
                    backupKey,
                    keyVersion,
                    mgr,
                );
            } catch (err) {
                console.error('Session key restore failed:', err);
            }
            if (cancelled) return;

            setSessionManager(mgr);

            // Restore contacts from backup (new device restore)
            if (cancelled) return;
            restoreContacts(token, userId, backupKey, keyVersion).catch((err) =>
                console.error('Contact restore failed:', err),
            );
        })();

        return () => {
            cancelled = true;
            setSessionManager((prev) => {
                prev?.destroy();
                return null;
            });
        };
    }, [userId, deviceId, token, backupKey, keyVersion]);

    const tokenRef = useRef(session?.token ?? null);
    tokenRef.current = session?.token ?? null;

    const handleLogout = useCallback(async () => {
        setSessionManager((prev) => {
            prev?.destroy();
            return null;
        });
        // Best-effort: remove device server-side before clearing local session
        const token = tokenRef.current;
        if (token) deleteDevice(token).catch(() => {});
        // Drop session state first so downstream components (useChat, SSE,
        // any effect that opens IndexedDB) unmount and close their IDB
        // connections. Otherwise `deleteDatabase` can be blocked by a
        // still-live connection and hang until it's eventually closed.
        setSession(null);
        // Yield so React flushes the unmount + effect cleanup before we
        // tear down IndexedDB.
        await new Promise((r) => setTimeout(r, 0));
        await clearSession();
    }, []);

    const handleUnauthorized = useCallback(async () => {
        setSessionManager((prev) => {
            prev?.destroy();
            return null;
        });
        setSession(null);
        await new Promise((r) => setTimeout(r, 0));
        clearToken();
    }, []);

    // Another device rotated the credential; this device's token is bound
    // to a superseded key_version. Wipe local IDB (its keys no longer
    // decrypt the server-side cipher anyway) and surface a calm notice
    // on /login. See docs/scenarios/credential-multi-device-cutoff.md.
    const handleKeyVersionStale = useCallback(async () => {
        setSessionManager((prev) => {
            prev?.destroy();
            return null;
        });
        setSession(null);
        await new Promise((r) => setTimeout(r, 0));
        await clearSession();
        setNotice('rotated_elsewhere');
    }, []);

    useEffect(() => {
        const u1 = onAuthEvent('device_revoked', handleLogout);
        const u2 = onAuthEvent('unauthorized', handleUnauthorized);
        const u3 = onAuthEvent('key_version_stale', handleKeyVersionStale);
        return () => {
            u1();
            u2();
            u3();
        };
    }, [handleLogout, handleUnauthorized, handleKeyVersionStale]);

    const handleLogin = (s: Session) => {
        setSession(s);
        // A fresh sign-in is the natural acknowledgement of the cutoff
        // notice — clear it so the next view of /login isn't stale.
        setNotice(null);
    };
    const clearNotice = () => setNotice(null);

    return {
        session,
        sessionManager,
        loading,
        notice,
        handleLogin,
        handleLogout,
        clearNotice,
    };
}
