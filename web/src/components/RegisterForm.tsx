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
import type { HandleAvailability } from '@/hooks/useHandleAvailability';
import type { PasswordStrength } from '@/hooks/usePasswordStrength';
import type { PowStatus, RegisterStep } from '@/hooks/useRegister';

interface Props {
    step: RegisterStep;
    handle: string;
    password: string;
    confirm: string;
    acknowledged: boolean;
    error: string;
    powStatus: PowStatus;
    provingMs: number;
    powHashes: number;
    strength: PasswordStrength;
    availability: HandleAvailability;
    onHandleChange: (value: string) => void;
    onSurpriseMe: () => void;
    onPasswordChange: (value: string) => void;
    onConfirmChange: (value: string) => void;
    onAcknowledgedChange: (value: boolean) => void;
    onRegister: () => void;
}

const AVAILABILITY_COLORS: Record<HandleAvailability['status'], string> = {
    idle: 'text-muted-foreground',
    invalid: 'text-destructive',
    checking: 'text-muted-foreground',
    available: 'text-green-600',
    taken: 'text-destructive',
    released: 'text-destructive',
    error: 'text-destructive',
};

export default function RegisterForm({
    step,
    handle,
    password,
    confirm,
    acknowledged,
    error,
    powStatus,
    provingMs,
    powHashes,
    strength,
    availability,
    onHandleChange,
    onSurpriseMe,
    onPasswordChange,
    onConfirmChange,
    onAcknowledgedChange,
    onRegister,
}: Props) {
    const canSubmit =
        availability.status === 'available' &&
        password.length > 0 &&
        password === confirm &&
        acknowledged;

    // PoW calibration readout (ADR-0020): grind time, attempts, per-hash cost.
    const powReadout =
        powHashes > 0 ? (
            <p className="mt-2 text-center font-mono text-xs tabular-nums text-muted-foreground">
                PoW: {(provingMs / 1000).toFixed(1)}s · {powHashes} hashes · ~
                {(provingMs / powHashes).toFixed(1)} ms/hash
            </p>
        ) : null;

    // Background-PoW status on the form, with the calibration numbers once ready.
    // Failed → nothing; the submit path solves inline.
    const powStatusLine =
        powStatus === 'failed' ? null : (
            <p className="mt-4 text-center text-xs tabular-nums text-muted-foreground">
                {powStatus === 'ready'
                    ? '🔒 Secure registration ready'
                    : `🔒 Preparing secure registration… ${(provingMs / 1000).toFixed(0)}s`}
                {powStatus === 'ready' &&
                    powHashes > 0 &&
                    ` · ${powHashes} hashes · ~${(provingMs / powHashes).toFixed(1)} ms/hash`}
            </p>
        );

    if (step === 'deriving' || step === 'proving') {
        return (
            <div className="flex min-h-screen items-center justify-center bg-background p-8">
                <div className="text-center">
                    <div className="mb-4 flex justify-center gap-2">
                        <span className="size-3 animate-pulse rounded-full bg-primary [animation-delay:-0.3s]" />
                        <span className="size-3 animate-pulse rounded-full bg-primary [animation-delay:-0.15s]" />
                        <span className="size-3 animate-pulse rounded-full bg-primary" />
                    </div>
                    <p className="text-lg font-medium">
                        {step === 'deriving'
                            ? 'Deriving your keys…'
                            : 'Verifying your device…'}
                    </p>
                    <p className="mt-2 text-sm text-muted-foreground">
                        This takes a few seconds and runs entirely on your
                        device.
                    </p>
                    {step === 'proving' && (
                        <p className="mt-2 font-mono text-sm tabular-nums text-muted-foreground">
                            {(provingMs / 1000).toFixed(1)}s
                        </p>
                    )}
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
                                <CardTitle>Pick a handle</CardTitle>
                                <CardDescription>
                                    Other people will use this to find you. 3–32
                                    lowercase letters, digits, or hyphens.
                                </CardDescription>
                            </CardHeader>
                            <CardContent className="space-y-2">
                                <label htmlFor="handle" className="sr-only">
                                    Handle
                                </label>
                                <div className="flex items-center gap-2">
                                    <span className="select-none text-muted-foreground">
                                        @
                                    </span>
                                    <input
                                        id="handle"
                                        type="text"
                                        value={handle}
                                        onChange={(e) =>
                                            onHandleChange(
                                                e.target.value.toLowerCase(),
                                            )
                                        }
                                        autoComplete="username"
                                        placeholder="alice-test"
                                        className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm"
                                    />
                                    <Button
                                        type="button"
                                        variant="outline"
                                        onClick={onSurpriseMe}
                                        data-testid="surprise-me"
                                    >
                                        Surprise me
                                    </Button>
                                </div>
                                {availability.message && (
                                    <p
                                        className={`text-xs ${AVAILABILITY_COLORS[availability.status]}`}
                                        data-testid="handle-availability"
                                    >
                                        {availability.message}
                                    </p>
                                )}
                            </CardContent>
                        </Card>

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

                        {powStatusLine}
                    </>
                )}

                {step === 'registering' && (
                    <Card>
                        <CardContent className="pt-6">
                            <p className="text-center text-muted-foreground">
                                Creating your account…
                            </p>
                            {powReadout}
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
                            {powReadout}
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
