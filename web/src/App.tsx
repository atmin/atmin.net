import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import Home from './Home';
import Landing from './Landing';
import Login from './Login';
import Register from './Register';
import { clearSession, loadSession, type Session } from './session';

function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadSession()
            .then(setSession)
            .finally(() => setLoading(false));
    }, []);

    const handleLogout = async () => {
        await clearSession();
        setSession(null);
    };

    if (loading) return null;

    return (
        <BrowserRouter>
            <Routes>
                <Route
                    path="/"
                    element={
                        session ? (
                            <Home session={session} onLogout={handleLogout} />
                        ) : (
                            <Landing />
                        )
                    }
                />
                <Route
                    path="/register"
                    element={
                        session ? <Navigate to="/" replace /> : <Register />
                    }
                />
                <Route
                    path="/login"
                    element={session ? <Navigate to="/" replace /> : <Login />}
                />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </BrowserRouter>
    );
}

export default App;
