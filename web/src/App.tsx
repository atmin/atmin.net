import { useEffect, useState } from 'react';
import { deriveKeys, generateBackupSecret } from './crypto';

type Status = 'checking' | 'connected' | 'offline';

function App() {
    const [status, setStatus] = useState<Status>('checking');
    const [result, setResult] = useState<string>('');

    useEffect(() => {
        fetch('/healthz')
            .then((r) => (r.ok ? 'connected' : 'offline') as Status)
            .catch(() => 'offline' as Status)
            .then(setStatus);
    }, []);

    const handleRegister = async () => {
        setResult('Registering...');
        try {
            const secret = generateBackupSecret();
            const keys = await deriveKeys(secret);

            const toB64 = (bytes: Uint8Array) =>
                btoa(String.fromCharCode(...bytes))
                    .replace(/\+/g, '-')
                    .replace(/\//g, '_')
                    .replace(/=+$/, '');

            const res = await fetch('/v1/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    device_label: 'Browser',
                    auth_public_key: toB64(keys.auth.publicKeyBytes),
                    sharing_public_key: toB64(keys.sharing.publicKeyBytes),
                }),
            });

            const data = await res.json();
            setResult(JSON.stringify(data, null, 2));
        } catch (e) {
            setResult(`Error: ${e}`);
        }
    };

    return (
        <div className="min-h-screen bg-stone-50 p-8 font-mono text-sm">
            <h1 className="mb-4 text-2xl font-bold">atmin</h1>

            <div className="mb-6 flex items-center gap-2">
                <span
                    className={`inline-block h-2 w-2 rounded-full ${
                        status === 'connected'
                            ? 'bg-green-500'
                            : status === 'offline'
                              ? 'bg-red-500'
                              : 'bg-yellow-500'
                    }`}
                />
                <span className="text-stone-600">
                    {status === 'connected'
                        ? 'Server connected'
                        : status === 'offline'
                          ? 'Server offline'
                          : 'Checking...'}
                </span>
            </div>

            <button
                type="button"
                onClick={handleRegister}
                disabled={status !== 'connected'}
                className="rounded bg-stone-800 px-4 py-2 text-white disabled:opacity-40"
            >
                Register test user
            </button>

            {result && (
                <pre className="mt-4 overflow-auto rounded bg-stone-100 p-4 text-xs">
                    {result}
                </pre>
            )}
        </div>
    );
}

export default App;
