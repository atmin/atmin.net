import { Block, Button, Navbar, NavbarBackLink, Page } from 'konsta/react';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import PasswordInput from '@/components/PasswordInput';

export type LoginFormNotice = 'rotated_elsewhere' | 'account_deleted' | null;

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
    // A just-deleted account lands here when its background session 401s
    // during teardown (the redirect from a protected route is /login). The
    // one-shot confirmation rides the same notice channel.
    account_deleted: '✓ Your account has been deleted.',
};

export default function LoginForm({
    loading,
    error,
    notice = null,
    onDismissNotice,
    onLogin,
}: Props) {
    const navigate = useNavigate();
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
        <Page>
            <Navbar
                title="Sign in"
                left={
                    <NavbarBackLink text="Back" onClick={() => navigate('/')} />
                }
            />

            <Block className="mt-6 text-sm opacity-70">
                Restore your account with your password.
            </Block>

            {notice && (
                <Block
                    className="text-sm opacity-70"
                    data-testid={
                        notice === 'account_deleted'
                            ? 'account-deleted-notice'
                            : 'login-notice'
                    }
                >
                    {NOTICE_TEXT[notice]}
                </Block>
            )}

            <form onSubmit={handleSubmit}>
                <Block strong inset className="space-y-5">
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
                                // Lowercase on input so the user sees exactly
                                // what'll be submitted — handles are lowercase
                                // ASCII per ADR-0013.
                                setHandle(e.target.value.toLowerCase());
                                dismissNoticeOnInput();
                            }}
                            placeholder="alice-test"
                            required
                            className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm"
                        />
                        <p className="mt-1 text-xs opacity-60">
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
                        <div className="text-sm text-red-500">
                            <p className="font-medium">Login failed</p>
                            <p>{error}</p>
                        </div>
                    )}
                </Block>

                <Block>
                    <Button
                        type="submit"
                        rounded
                        large
                        disabled={loading || !handle || !secret}
                    >
                        {loading ? 'Signing in...' : 'Sign In'}
                    </Button>
                </Block>
            </form>

            <Block className="text-center text-sm opacity-70">
                Don't have an account?{' '}
                <button
                    type="button"
                    className="underline"
                    onClick={() => navigate('/register')}
                >
                    Create one
                </button>
            </Block>
        </Page>
    );
}
