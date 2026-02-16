import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';

interface Props {
    loading: boolean;
    error: string;
    onLogin: (inviteHandle: string, mnemonic: string) => void;
}

export default function LoginForm({ loading, error, onLogin }: Props) {
    const [inviteHandle, setInviteHandle] = useState('');
    const [mnemonic, setMnemonic] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onLogin(inviteHandle, mnemonic);
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-stone-50 p-8">
            <div className="w-full max-w-md">
                <h1 className="mb-8 text-2xl font-bold">
                    <a href="/" className="hover:text-stone-600">
                        atmin
                    </a>
                </h1>

                <Card>
                    <CardHeader>
                        <CardTitle>Sign In</CardTitle>
                        <CardDescription>
                            Restore your account using your recovery phrase
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div>
                                <label
                                    htmlFor="invite-handle"
                                    className="mb-1 block text-sm font-medium"
                                >
                                    Invite Handle
                                </label>
                                <input
                                    id="invite-handle"
                                    type="text"
                                    value={inviteHandle}
                                    onChange={(e) =>
                                        setInviteHandle(e.target.value)
                                    }
                                    placeholder="copper-falcon"
                                    required
                                    className="w-full rounded border border-stone-300 px-3 py-2 text-sm"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="mnemonic"
                                    className="mb-1 block text-sm font-medium"
                                >
                                    Recovery Phrase
                                </label>
                                <textarea
                                    id="mnemonic"
                                    value={mnemonic}
                                    onChange={(e) =>
                                        setMnemonic(e.target.value)
                                    }
                                    placeholder="word1 word2 word3 ... word12"
                                    required
                                    rows={3}
                                    className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-sm"
                                />
                                <p className="mt-1 text-xs text-stone-500">
                                    Enter your 12-word recovery phrase
                                </p>
                            </div>

                            {error && (
                                <Alert variant="destructive">
                                    <AlertTitle>Login Failed</AlertTitle>
                                    <AlertDescription>{error}</AlertDescription>
                                </Alert>
                            )}

                            <Button
                                type="submit"
                                disabled={loading || !inviteHandle || !mnemonic}
                                className="w-full"
                            >
                                {loading ? 'Signing in...' : 'Sign In'}
                            </Button>
                        </form>
                    </CardContent>
                </Card>

                <p className="mt-4 text-center text-sm text-stone-500">
                    Don't have an account?{' '}
                    <a href="/register" className="underline">
                        Create one
                    </a>
                </p>
            </div>
        </div>
    );
}
