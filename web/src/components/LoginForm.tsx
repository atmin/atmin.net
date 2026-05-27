import { useState } from 'react';
import PasswordInput from '@/components/PasswordInput';
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
    onLogin: (handle: string, secret: string) => void;
}

export default function LoginForm({ loading, error, onLogin }: Props) {
    const [handle, setHandle] = useState('');
    const [secret, setSecret] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onLogin(handle, secret);
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-8">
            <div className="w-full max-w-md">
                <h1 className="mb-8 text-2xl font-bold">
                    <a href="/" className="hover:text-foreground">
                        atmin
                    </a>
                </h1>

                <Card>
                    <CardHeader>
                        <CardTitle>Sign In</CardTitle>
                        <CardDescription>
                            Restore your account with your password or recovery
                            phrase
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleSubmit} className="space-y-4">
                            <div>
                                <label
                                    htmlFor="handle"
                                    className="mb-1 block text-sm font-medium"
                                >
                                    Handle
                                </label>
                                <input
                                    id="handle"
                                    type="text"
                                    value={handle}
                                    onChange={(e) => setHandle(e.target.value)}
                                    placeholder="copper-falcon"
                                    required
                                    className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="secret"
                                    className="mb-1 block text-sm font-medium"
                                >
                                    Password or recovery phrase
                                </label>
                                <PasswordInput
                                    id="secret"
                                    value={secret}
                                    onChange={setSecret}
                                    placeholder="Password or recovery phrase"
                                    autoComplete="current-password"
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Enter your password, or your legacy 12-word
                                    recovery phrase.
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
                                disabled={loading || !handle || !secret}
                                className="w-full"
                            >
                                {loading ? 'Signing in...' : 'Sign In'}
                            </Button>
                        </form>
                    </CardContent>
                </Card>

                <p className="mt-4 text-center text-sm text-muted-foreground">
                    Don't have an account?{' '}
                    <a href="/register" className="underline">
                        Create one
                    </a>
                </p>
            </div>
        </div>
    );
}
