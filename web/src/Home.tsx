import { useEffect, useState } from 'react';
import type { Session } from './session';
import { clearSession } from './session';

interface Props {
    session: Session;
    onLogout: () => void;
}

export default function Home({ session, onLogout }: Props) {
    const [copied, setCopied] = useState(false);
    const [serverOk, setServerOk] = useState<boolean | null>(null);

    useEffect(() => {
        fetch('/healthz')
            .then((r) => setServerOk(r.ok))
            .catch(() => setServerOk(false));
    }, []);

    const copyHandle = () => {
        navigator.clipboard.writeText(session.inviteHandle);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    const handleLogout = async () => {
        await clearSession();
        onLogout();
    };

    return (
        <div className="min-h-screen bg-stone-50 p-8 font-mono text-sm">
            <div className="mx-auto max-w-md">
                <div className="mb-8 flex items-center justify-between">
                    <h1 className="text-2xl font-bold">atmin</h1>
                    <div className="flex items-center gap-2">
                        <span
                            className={`inline-block h-2 w-2 rounded-full ${
                                serverOk === true
                                    ? 'bg-green-500'
                                    : serverOk === false
                                      ? 'bg-red-500'
                                      : 'bg-yellow-500'
                            }`}
                        />
                    </div>
                </div>

                <div className="mb-6 rounded bg-stone-100 p-4">
                    <p className="mb-1 text-xs text-stone-500">
                        Your invite handle
                    </p>
                    <div className="flex items-center justify-between">
                        <span className="text-lg">{session.inviteHandle}</span>
                        <button
                            type="button"
                            onClick={copyHandle}
                            className="text-xs text-stone-500 hover:text-stone-800"
                        >
                            {copied ? 'Copied' : 'Copy'}
                        </button>
                    </div>
                </div>

                <div className="rounded border border-dashed border-stone-300 p-8 text-center text-stone-400">
                    Conversations will appear here
                </div>

                <button
                    type="button"
                    onClick={handleLogout}
                    className="mt-8 text-xs text-stone-400 hover:text-red-600"
                >
                    Sign out
                </button>
            </div>
        </div>
    );
}
