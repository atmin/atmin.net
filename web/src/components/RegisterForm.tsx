import PasswordField from '@/components/PasswordField';
import PasswordStrengthMeter from '@/components/PasswordStrengthMeter';
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
import type { PasswordStrength } from '@/hooks/usePasswordStrength';
import type { RegisterStep } from '@/hooks/useRegister';

interface Props {
    step: RegisterStep;
    password: string;
    confirm: string;
    acknowledged: boolean;
    error: string;
    strength: PasswordStrength;
    onPasswordChange: (value: string) => void;
    onConfirmChange: (value: string) => void;
    onAcknowledgedChange: (value: boolean) => void;
    onRegister: () => void;
}

export default function RegisterForm({
    step,
    password,
    confirm,
    acknowledged,
    error,
    strength,
    onPasswordChange,
    onConfirmChange,
    onAcknowledgedChange,
    onRegister,
}: Props) {
    const canSubmit =
        password.length > 0 && password === confirm && acknowledged;

    if (step === 'deriving') {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background p-8">
                <div className="text-center">
                    <div className="mb-4 flex justify-center gap-2">
                        <span className="size-3 animate-pulse rounded-full bg-primary [animation-delay:-0.3s]" />
                        <span className="size-3 animate-pulse rounded-full bg-primary [animation-delay:-0.15s]" />
                        <span className="size-3 animate-pulse rounded-full bg-primary" />
                    </div>
                    <p className="text-lg font-medium">Deriving your keys…</p>
                    <p className="mt-2 text-sm text-muted-foreground">
                        This takes a few seconds and runs entirely on your
                        device.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="flex min-h-screen items-center justify-center bg-background p-8">
            <div className="w-full max-w-md">
                <h1 className="mb-8 text-2xl font-bold">
                    <a href="/" className="hover:text-foreground">
                        atmin
                    </a>
                </h1>

                {step === 'enter' && (
                    <>
                        <Card className="mb-6">
                            <CardHeader>
                                <CardTitle>Choose a password</CardTitle>
                                <CardDescription>
                                    Your password derives your encryption keys
                                    locally. It's never sent anywhere or stored.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-4">
                                <PasswordField
                                    password={password}
                                    confirm={confirm}
                                    onPasswordChange={onPasswordChange}
                                    onConfirmChange={onConfirmChange}
                                />
                                {password.length > 0 && (
                                    <PasswordStrengthMeter
                                        score={strength.score}
                                        feedback={strength.feedback}
                                        pwned={strength.pwned}
                                        loading={strength.loading}
                                    />
                                )}
                            </CardContent>
                        </Card>

                        <Alert className="mb-6">
                            <AlertTitle>⚠️ Critical Security Warning</AlertTitle>
                            <AlertDescription className="space-y-2 text-sm">
                                <p>
                                    There is no password reset. If you forget
                                    this password and lose your devices, your
                                    account and message history are gone
                                    forever.
                                </p>
                                <p>
                                    Store it in a password manager like{' '}
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
                            </AlertDescription>
                        </Alert>

                        <div className="mb-6">
                            {/* biome-ignore lint/a11y/noLabelWithoutControl: Radix UI Checkbox handles accessibility */}
                            <label className="flex items-start gap-3">
                                <Checkbox
                                    checked={acknowledged}
                                    onCheckedChange={(checked) =>
                                        onAcknowledgedChange(checked === true)
                                    }
                                />
                                <span className="text-sm">
                                    I understand that my password cannot be
                                    reset and is the only way to recover my
                                    account
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
                            disabled={!canSubmit}
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
                                Creating your account…
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
                                Redirecting…
                            </p>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
