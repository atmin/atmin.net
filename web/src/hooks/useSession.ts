import { useCallback, useEffect, useRef, useState } from 'react';
import { deleteDevice, setOnDeviceRevoked, setOnUnauthorized } from '@/lib/api';
import {
    clearSession,
    clearToken,
    loadSession,
    type Session,
} from '@/lib/auth';
import { restoreContacts } from '@/lib/contact-backup';
import { restoreSessionKeys } from '@/lib/key-backup';
import type { SessionManager } from '@/lib/megolm-session';

export interface SessionState {
    session: Session | null;
    sessionManager: SessionManager | null;
    loading: boolean;
    handleLogin: (session: Session) => void;
    handleLogout: () => Promise<void>;
}

export function useSession(): SessionState {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
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
                    ).catch((err) => console.error('Key backup failed:', err)),
            );
            if (cancelled) return;

            // Restore inbound session keys before first sync (see docs/scenarios/account-recovery.md)
            try {
                await restoreSessionKeys(token, userId, backupKey, mgr);
            } catch (err) {
                console.error('Session key restore failed:', err);
            }
            if (cancelled) return;

            setSessionManager(mgr);

            // Restore contacts from backup (new device restore)
            if (cancelled) return;
            restoreContacts(token, userId, backupKey).catch((err) =>
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
    }, [userId, deviceId, token, backupKey]);

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

    useEffect(() => {
        setOnDeviceRevoked(handleLogout);
        return () => setOnDeviceRevoked(null);
    }, [handleLogout]);

    useEffect(() => {
        setOnUnauthorized(handleUnauthorized);
        return () => setOnUnauthorized(null);
    }, [handleUnauthorized]);

    const handleLogin = (s: Session) => setSession(s);

    return { session, sessionManager, loading, handleLogin, handleLogout };
}
