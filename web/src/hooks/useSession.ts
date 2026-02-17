import { useEffect, useState } from 'react';
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
    // Depend on session.userId (stable string) rather than the session
    // object itself, which gets a new reference on every loadSession() call.
    // This prevents React StrictMode's double-invocation from spawning
    // two concurrent createSessionManager calls that race on IndexedDB.
    const sessionUserId = session?.userId ?? null;
    useEffect(() => {
        if (!session) return;

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
                session.userId,
                session.deviceId,
                (sessionId, sessionKey) =>
                    backupSessionKey(
                        session.token,
                        session.userId,
                        sessionId,
                        sessionKey,
                        session.backupKey,
                    ).catch((err) =>
                        console.error('Key backup failed:', err),
                    ),
            );
            if (cancelled) return;
            setSessionManager(mgr);
        })();

        return () => {
            cancelled = true;
            setSessionManager((prev) => {
                prev?.destroy();
                return null;
            });
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sessionUserId]);

    const handleLogout = async () => {
        setSessionManager((prev) => {
            prev?.destroy();
            return null;
        });
        await clearSession();
        setSession(null);
    };

    const handleLogin = (s: Session) => setSession(s);

    return { session, sessionManager, loading, handleLogin, handleLogout };
}
