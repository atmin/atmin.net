import { App as KonstaApp } from 'konsta/react';
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
import { useKonstaTheme } from '@/hooks/useKonstaTheme';
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
    // ADR-0023: Konsta theme context + chrome. T0 adds the provider only — it's
    // a themed wrapper <div> (k-ios/k-material, safe-areas) plus context; Konsta
    // `Page`/components arrive per-screen in T1+, so existing shadcn screens
    // render unchanged inside it. `dark` composes with the existing `.dark`
    // class on <html> (Konsta's dark variant is .dark-based).
    const { theme } = useKonstaTheme();

    if (loading) return null;

    return (
        <KonstaApp theme={theme} dark safeAreas>
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
                                    onLogout={handleLogout}
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
                {/* Bottom overlay slot — Konsta Toasts all anchor to the same
                    fixed bottom edge, so at most one shows at a time, picked by
                    priority. Offline is transient + most actionable; the restore
                    warning persists until dismissed; the SW-update prompt is the
                    least urgent. A suppressed lower-priority overlay resurfaces
                    once the higher one clears (each is still conditionally
                    mounted, so it unmounts cleanly when its condition ends). */}
                {!online ? (
                    <OfflineIndicator />
                ) : session && restoreWarning !== null ? (
                    <RestoreWarningToast
                        count={restoreWarning}
                        onDismiss={clearRestoreWarning}
                    />
                ) : swUpdate.needRefresh ? (
                    <SWUpdateToast
                        sending={chatSending}
                        onUpdate={swUpdate.onUpdate}
                        onDismiss={swUpdate.onDismiss}
                    />
                ) : null}
            </BrowserRouter>
        </KonstaApp>
    );
}
