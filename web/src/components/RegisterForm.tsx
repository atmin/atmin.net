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
import { Checkbox } from '@/components/ui/checkbox';
import type { RegisterStep } from '@/hooks/useRegister';

interface Props {
    step: RegisterStep;
    mnemonic: string;
    error: string;
    onRegister: () => void;
}

export default function RegisterForm({
    step,
    mnemonic,
    error,
    onRegister,
}: Props) {
    const [copied, setCopied] = useState(false);
    const [understood, setUnderstood] = useState(false);
    const [stored, setStored] = useState(false);

    const handleCopy = () => {
        navigator.clipboard.writeText(mnemonic);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-8">
            <div className="w-full max-w-md">
                <h1 className="mb-8 text-2xl font-bold">
                    <a href="/" className="hover:text-foreground">
                        atmin
                    </a>
                </h1>

                {step === 'generate' && (
                    <>
                        <Card className="mb-6">
                            <CardHeader>
                                <CardTitle>Your Recovery Phrase</CardTitle>
                                <CardDescription>
                                    Write down these 12 words in order. This is
                                    the only way to recover your account.
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="mb-4 rounded border border-border bg-muted p-4 font-mono text-sm">
                                    {mnemonic}
                                </div>
                                <Button
                                    onClick={handleCopy}
                                    variant="outline"
                                    className="w-full"
                                >
                                    {copied ? 'Copied!' : 'Copy to Clipboard'}
                                </Button>
                            </CardContent>
                        </Card>

                        <Alert className="mb-6">
                            <AlertTitle>⚠️ Critical Security Warning</AlertTitle>
                            <AlertDescription className="space-y-2 text-sm">
                                <p>
                                    Anyone with these words can access your
                                    account and read all your messages.
                                </p>
                                <p>
                                    Store them securely in a password manager
                                    like{' '}
                                    <a
                                        href="https://en.wikipedia.org/wiki/List_of_password_managers"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="underline"
                                    >
                                        1Password, Bitwarden, or KeePass
                                    </a>
                                    .
                                </p>
                                <p className="font-semibold">
                                    If you lose these words, your account and
                                    message history cannot be recovered.
                                </p>
                            </AlertDescription>
                        </Alert>

                        <div className="mb-6 space-y-3">
                            {/* biome-ignore lint/a11y/noLabelWithoutControl: Radix UI Checkbox handles accessibility */}
                            <label className="flex items-start gap-3">
                                <Checkbox
                                    checked={understood}
                                    onCheckedChange={(checked) =>
                                        setUnderstood(checked === true)
                                    }
                                />
                                <span className="text-sm">
                                    I understand that these words are the only
                                    way to recover my account
                                </span>
                            </label>

                            {/* biome-ignore lint/a11y/noLabelWithoutControl: Radix UI Checkbox handles accessibility */}
                            <label className="flex items-start gap-3">
                                <Checkbox
                                    checked={stored}
                                    onCheckedChange={(checked) =>
                                        setStored(checked === true)
                                    }
                                />
                                <span className="text-sm">
                                    I have stored these words in a safe place
                                </span>
                            </label>
                        </div>

                        {error && (
                            <p className="mb-4 text-sm text-destructive">
                                {error}
                            </p>
                        )}

                        <Button
                            onClick={onRegister}
                            disabled={!understood || !stored}
                            className="w-full"
                        >
                            Register
                        </Button>
                    </>
                )}

                {step === 'registering' && (
                    <Card>
                        <CardContent className="pt-6">
                            <p className="text-center text-muted-foreground">
                                Creating your account...
                            </p>
                        </CardContent>
                    </Card>
                )}

                {step === 'done' && (
                    <Card>
                        <CardContent className="pt-6">
                            <p className="mb-2 text-center text-green-600">
                                ✓ Account created successfully
                            </p>
                            <p className="text-center text-sm text-muted-foreground">
                                Redirecting...
                            </p>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
