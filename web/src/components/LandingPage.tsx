import { Button, Page } from 'konsta/react';
import { useNavigate } from 'react-router-dom';
import Logo from '@/components/Logo';

interface Props {
    // One-shot confirmation after a successful account deletion.
    accountDeleted?: boolean;
    onDismiss?: () => void;
}

export default function LandingPage({
    accountDeleted = false,
    onDismiss = () => {},
}: Props) {
    const navigate = useNavigate();

    const go = (path: string) => {
        onDismiss();
        navigate(path);
    };

    return (
        <Page>
            {/* Bare splash (ADR-0023 T3): logo, wordmark, tagline, two actions,
                version footer pinned to the bottom. The AuroraBackground hero
                retired with the Konsta migration. */}
            <div className="flex min-h-full flex-col px-8 py-10 text-center">
                <div className="flex flex-1 flex-col items-center justify-center">
                    {accountDeleted && (
                        <p
                            className="mb-8 text-sm opacity-60"
                            data-testid="account-deleted-notice"
                        >
                            ✓ Your account has been deleted.
                        </p>
                    )}

                    <Logo className="h-20 w-20" />
                    <h1 className="mt-4 text-3xl font-bold tracking-tight">
                        atmin
                    </h1>
                    <p className="mt-2 text-base opacity-60">
                        End-to-end encrypted messenger
                    </p>

                    <div className="mt-10 w-full max-w-xs space-y-3">
                        <Button rounded large onClick={() => go('/register')}>
                            Create account
                        </Button>
                        <Button
                            rounded
                            large
                            outline
                            onClick={() => go('/login')}
                        >
                            Sign in
                        </Button>
                    </div>
                </div>

                <p className="mt-8 text-xs opacity-50">
                    {__APP_VERSION__} • Open source •{' '}
                    <a
                        href="https://github.com/yourusername/atmin"
                        className="underline"
                    >
                        Documentation
                    </a>
                </p>
            </div>
        </Page>
    );
}
