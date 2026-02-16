import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';

export default function LandingPage() {
    return (
        <div className="flex min-h-screen items-center justify-center bg-stone-50 p-8">
            <div className="w-full max-w-md">
                <h1 className="mb-8 text-3xl font-bold">atmin</h1>

                <Card className="mb-6">
                    <CardHeader>
                        <CardTitle>End-to-end encrypted messenger</CardTitle>
                        <CardDescription>
                            Private conversations with no server access to your
                            messages
                        </CardDescription>
                    </CardHeader>
                    <CardContent className="space-y-2 text-sm text-stone-600">
                        <p>
                            • Messages encrypted with Megolm (Matrix protocol)
                        </p>
                        <p>• Your keys, your data</p>
                        <p>• Zero-knowledge architecture</p>
                    </CardContent>
                </Card>

                <div className="flex gap-3">
                    <Button asChild className="flex-1">
                        <Link to="/register">Create Account</Link>
                    </Button>
                    <Button asChild variant="outline" className="flex-1">
                        <Link to="/login">Sign In</Link>
                    </Button>
                </div>

                <p className="mt-6 text-center text-xs text-stone-400">
                    v0.1 • Open source •{' '}
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
