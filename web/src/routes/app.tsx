import { useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { OfflineIndicator } from '@/components/OfflineIndicator';
import { SWUpdateToast } from '@/components/SWUpdateToast';
import { useInboxSync } from '@/hooks/useInboxSync';
import { useOnlineStatus } from '@/hooks/useOnlineStatus';
import { useSession } from '@/hooks/useSession';
import { useSWUpdate } from '@/hooks/useSWUpdate';
import Chat from '@/routes/chat';
import Chats from '@/routes/chats';
import Landing from '@/routes/landing';
import Login from '@/routes/login';
import Register from '@/routes/register';
import Settings from '@/routes/settings';

export default function App() {
    const { session, sessionManager, loading, handleLogin, handleLogout } =
        useSession();
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
                            <Login onSuccess={handleLogin} />
                        )
                    }
                />

                {/* Settings */}
                <Route
                    path="/settings"
                    element={
                        session ? (
                            <Settings session={session} />
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
            {!online && <OfflineIndicator />}
        </BrowserRouter>
    );
}
