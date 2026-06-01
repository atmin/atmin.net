import { useState } from 'react';
import {
    BrowserRouter,
    Navigate,
    Route,
    Routes,
    useLocation,
} from 'react-router-dom';
import NotFound from '@/components/NotFound';
import { OfflineIndicator } from '@/components/OfflineIndicator';
import { RestoreWarningToast } from '@/components/RestoreWarningToast';
import { SWUpdateToast } from '@/components/SWUpdateToast';
import { useInboxSync } from '@/hooks/useInboxSync';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useSession } from '@/hooks/useSession';
import { useSWUpdate } from '@/hooks/useSWUpdate';
import type { Session } from '@/lib/auth';
import { validateHandleShape } from '@/lib/handle-suggest';
import type { SessionManager } from '@/lib/megolm-session';
import Chat from '@/routes/chat';
import Chats from '@/routes/chats';
import Landing from '@/routes/landing';
import Login from '@/routes/login';
import Register from '@/routes/register';
import Settings from '@/routes/settings';

// Splat-route wrapper for the user-handle URL convention `/@{handle}`.
// React Router v7 doesn't support partial-segment patterns (`/@:handle`
// doesn't match), so the route catches everything and we discriminate
// in this wrapper. `/saved` is handled separately as Saved Messages.
function HandleOrNotFound({
    session,
    sessionManager,
    onSendingChange,
}: {
    session: Session;
    sessionManager: SessionManager | null;
    onSendingChange: (sending: boolean) => void;
}) {
    const { pathname } = useLocation();
    // Saved Messages: special-case before handle parsing.
    if (pathname === '/saved') {
        return (
            <Chat
                handle="saved"
                session={session}
                sessionManager={sessionManager}
                onSendingChange={onSendingChange}
            />
        );
    }
    if (pathname.startsWith('/@')) {
        const candidate = decodeURIComponent(pathname.slice(2));
        if (validateHandleShape(candidate) === null) {
            return (
                <Chat
                    handle={candidate}
                    session={session}
                    sessionManager={sessionManager}
                    onSendingChange={onSendingChange}
                />
            );
        }
    }
    // Anything else (legacy `/handle` without `@`, malformed handle,
    // unknown system path) is a 404 — no silent fallback to Landing.
    return <NotFound />;
}

export default function App() {
    const {
        session,
        sessionManager,
        loading,
        notice,
        restoreWarning,
        handleLogin,
        handleLogout,
        handleAccountDeleted,
        clearNotice,
        clearRestoreWarning,
    } = useSession();
    useInboxSync(session, sessionManager);
    const online = useOnlineStatus();
    const [chatSending, setChatSending] = useState(false);
    const swUpdate = useSWUpdate(chatSending);

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
                            <Register onSuccess={handleLogin} />
                        )
                    }
                />
                <Route
                    path="/login"
                    element={
                        session ? (
                            <Navigate to="/" replace />
                        ) : (
                            <Login
                                onSuccess={handleLogin}
                                notice={notice}
                                onDismissNotice={clearNotice}
                            />
                        )
                    }
                />

                {/* Settings */}
                <Route
                    path="/settings"
                    element={
                        session ? (
                            <Settings
                                session={session}
                                onSessionChange={handleLogin}
                                onDeleted={handleAccountDeleted}
                            />
                        ) : (
                            <Navigate to="/login" replace />
                        )
                    }
                />

                {/* Chat routes */}
                <Route
                    path="/"
                    element={
                        session ? (
                            <Chats
                                session={session}
                                sessionManager={sessionManager}
                                onLogout={handleLogout}
                            />
                        ) : (
                            <Landing
                                notice={notice}
                                onDismissNotice={clearNotice}
                            />
                        )
                    }
                />
                {/* Splat catch-all: handles `/@{handle}` (chat),
                    `/saved`, and 404s for anything else. Order-sensitive
                    — declared last so specific routes win first. */}
                <Route
                    path="*"
                    element={
                        session ? (
                            <HandleOrNotFound
                                session={session}
                                sessionManager={sessionManager}
                                onSendingChange={setChatSending}
                            />
                        ) : (
                            <Navigate to="/login" replace />
                        )
                    }
                />
            </Routes>
            {swUpdate.needRefresh && (
                <SWUpdateToast
                    sending={chatSending}
                    onUpdate={swUpdate.onUpdate}
                    onDismiss={swUpdate.onDismiss}
                />
            )}
            {session && restoreWarning !== null && (
                <RestoreWarningToast
                    count={restoreWarning}
                    onDismiss={clearRestoreWarning}
                />
            )}
            {!online && <OfflineIndicator />}
        </BrowserRouter>
    );
}
