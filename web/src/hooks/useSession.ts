import { useCallback, useEffect, useState } from 'react';
import { setOnDeviceRevoked } from '@/lib/api';
import { clearSession, loadSession, type Session } from '@/lib/auth';
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
            setSessionManager(mgr);

            // Restore contacts from backup (new device restore)
            const { restoreContacts } = await import('@/lib/contact-backup');
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

    const handleLogout = useCallback(async () => {
        setSessionManager((prev) => {
            prev?.destroy();
            return null;
        });
        await clearSession();
        setSession(null);
    }, []);

    useEffect(() => {
        setOnDeviceRevoked(handleLogout);
        return () => setOnDeviceRevoked(null);
    }, [handleLogout]);

    const handleLogin = (s: Session) => setSession(s);

    return { session, sessionManager, loading, handleLogin, handleLogout };
}
