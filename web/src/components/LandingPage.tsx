import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';

interface Props {
    // One-shot confirmation after a successful account deletion.
    accountDeleted?: boolean;
    onDismiss?: () => void;
}

export default function LandingPage({
    accountDeleted = false,
    onDismiss = () => {},
}: Props) {
    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-8">
            <div className="w-full max-w-md">
                {accountDeleted && (
                    <p
                        className="mb-6 text-sm text-muted-foreground"
                        data-testid="account-deleted-notice"
                    >
                        ✓ Your account has been deleted.
                    </p>
                )}
                <h1 className="mb-8 text-3xl font-bold">atmin</h1>

                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle>End-to-end encrypted messenger</CardTitle>
                        <CardDescription>
                            Private conversations with no server access to your
                            messages
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm text-muted-foreground">
                        <p>
                            • Messages encrypted with Megolm (Matrix protocol)
                        </p>
                        <p>• Your keys, your data</p>
                        <p>• Zero-knowledge architecture</p>
                    </CardContent>
                </Card>

                <div className="flex gap-3">
                    <Button asChild className="flex-1">
                        <Link to="/register" onClick={onDismiss}>
                            Create Account
                        </Link>
                    </Button>
                    <Button asChild variant="outline" className="flex-1">
                        <Link to="/login" onClick={onDismiss}>
                            Sign In
                        </Link>
                    </Button>
                </div>

                <p className="mt-6 text-center text-xs text-muted-foreground">
                    {__APP_VERSION__} • Open source •{' '}
                    <a
                        href="https://github.com/yourusername/atmin"
                        className="underline"
                    >
                        Documentation
                    </a>
                </p>
            </div>
        </div>
    );
}
