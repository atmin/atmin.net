import { useEffect, useRef, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { clearSession, loadSession, type Session } from './auth';
import Chat from './Chat';
import Chats from './Chats';
import Landing from './Landing';
import Login from './Login';
import type { SessionManager } from './megolm-session';
import Register from './Register';

function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);
    const sessionManagerRef = useRef<SessionManager | null>(null);

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
            const { loadWasm } = await import('./wasm');
            const { createSessionManager } = await import('./megolm-session');
            const wasm = await loadWasm();
            if (cancelled) return;
            sessionManagerRef.current = createSessionManager(wasm);
        })();

        return () => {
            cancelled = true;
            sessionManagerRef.current?.destroy();
            sessionManagerRef.current = null;
        };
    }, [session]);

    const handleLogout = async () => {
        sessionManagerRef.current?.destroy();
        sessionManagerRef.current = null;
        await clearSession();
        setSession(null);
    };

    if (loading) return null;

    return (
        <BrowserRouter>
            <Routes>
                {/* Auth routes */}
                <Route
                    path="/register"
                    element={
                        session ? (
                            <Navigate to="/" replace />
                        ) : (
                            <Register onSuccess={setSession} />
                        )
                    }
                />
                <Route
                    path="/login"
                    element={
                        session ? (
                            <Navigate to="/" replace />
                        ) : (
                            <Login onSuccess={setSession} />
                        )
                    }
                />

                {/* Chat routes */}
                <Route
                    path="/"
                    element={
                        session ? (
                            <Chats session={session} onLogout={handleLogout} />
                        ) : (
                            <Landing />
                        )
                    }
                />
                <Route
                    path="/:handle"
                    element={
                        session ? (
                            <Chat
                                session={session}
                                sessionManager={sessionManagerRef.current}
                            />
                        ) : (
                            <Navigate to="/login" replace />
                        )
                    }
                />
            </Routes>
        </BrowserRouter>
    );
}

export default App;
