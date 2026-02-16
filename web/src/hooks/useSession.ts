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

    // Init WASM + session manager when session is available
    useEffect(() => {
        if (!session) return;

        let cancelled = false;

        (async () => {
            const { loadWasm } = await import('@/lib/wasm');
            const { createSessionManager } = await import(
                '@/lib/megolm-session'
            );
            const { backupSessionKey } = await import('@/lib/key-backup');
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
    }, [session]);

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
