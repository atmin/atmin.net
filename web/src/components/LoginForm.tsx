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

export type LoginFormNotice = 'rotated_elsewhere' | null;

interface Props {
    loading: boolean;
    error: string;
    notice?: LoginFormNotice;
    onDismissNotice?: () => void;
    onLogin: (handle: string, secret: string) => void;
}

const NOTICE_TEXT: Record<
    NonNullable<Exclude<LoginFormNotice, null>>,
    string
> = {
    rotated_elsewhere:
        'This account was rotated on another device. Please sign in with your new password.',
};

export default function LoginForm({
    loading,
    error,
    notice = null,
    onDismissNotice,
    onLogin,
}: Props) {
    const [handle, setHandle] = useState('');
    const [secret, setSecret] = useState('');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        onLogin(handle, secret);
    };

    const dismissNoticeOnInput = () => {
        if (notice) onDismissNotice?.();
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
                            Restore your account with your password
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        {notice && (
                            <p
                                className="mb-4 text-sm text-muted-foreground"
                                data-testid="login-notice"
                            >
                                {NOTICE_TEXT[notice]}
                            </p>
                        )}
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
                                    onChange={(e) => {
                                        // Lowercase on input so the user sees
                                        // exactly what'll be submitted —
                                        // handles are lowercase ASCII per
                                        // ADR-0013.
                                        setHandle(e.target.value.toLowerCase());
                                        dismissNoticeOnInput();
                                    }}
                                    placeholder="alice-test"
                                    required
                                    className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                                />
                                <p className="mt-1 text-xs text-muted-foreground">
                                    Handles are lowercase.
                                </p>
                            </div>

                            <div>
                                <label
                                    htmlFor="secret"
                                    className="mb-1 block text-sm font-medium"
                                >
                                    Password
                                </label>
                                <PasswordInput
                                    id="secret"
                                    value={secret}
                                    onChange={(v) => {
                                        setSecret(v);
                                        dismissNoticeOnInput();
                                    }}
                                    placeholder="Password"
                                    autoComplete="current-password"
                                />
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
