import { useEffect, useState } from 'react';
import Home from './Home';
import Registration from './Registration';
import { loadSession, type Session } from './session';

function App() {
    const [session, setSession] = useState<Session | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        loadSession()
            .then(setSession)
            .finally(() => setLoading(false));
    }, []);

    if (loading) return null;
    if (!session) return <Registration onComplete={setSession} />;
    return <Home session={session} onLogout={() => setSession(null)} />;
}

export default App;
