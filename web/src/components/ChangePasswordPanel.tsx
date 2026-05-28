import PasswordInput from '@/components/PasswordInput';
import PasswordStrengthMeter from '@/components/PasswordStrengthMeter';
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
import type { RotateStep } from '@/hooks/useRotateKeys';

interface Props {
    step: RotateStep;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    acknowledged: boolean;
    error: string | null;
    strength: PasswordStrength;
    onCurrentChange: (value: string) => void;
    onNewChange: (value: string) => void;
    onConfirmChange: (value: string) => void;
    onAcknowledgedChange: (value: boolean) => void;
    onSubmit: () => void;
}

function StepCover({ label }: { label: string }) {
    return (
        <Card>
            <CardContent className="pt-6 text-center">
                <div className="mb-4 flex justify-center gap-2">
                    <span className="size-3 animate-pulse rounded-full bg-primary [animation-delay:-0.3s]" />
                    <span className="size-3 animate-pulse rounded-full bg-primary [animation-delay:-0.15s]" />
                    <span className="size-3 animate-pulse rounded-full bg-primary" />
                </div>
                <p className="text-sm font-medium">{label}</p>
            </CardContent>
        </Card>
    );
}

export default function ChangePasswordPanel({
    step,
    currentPassword,
    newPassword,
    confirmPassword,
    acknowledged,
    error,
    strength,
    onCurrentChange,
    onNewChange,
    onConfirmChange,
    onAcknowledgedChange,
    onSubmit,
}: Props) {
    const mismatch =
        confirmPassword.length > 0 && newPassword !== confirmPassword;
    const canSubmit =
        currentPassword.length > 0 &&
        newPassword.length > 0 &&
        newPassword === confirmPassword &&
        acknowledged &&
        step === 'enter';

    if (step === 'deriving-old') {
        return <StepCover label="Verifying your current password…" />;
    }
    if (step === 'deriving-new') {
        return <StepCover label="Deriving keys for your new password…" />;
    }
    if (step === 'writing-chain') {
        return <StepCover label="Writing key chain…" />;
    }
    if (step === 'rotating') {
        return <StepCover label="Rotating credentials on the server…" />;
    }
    if (step === 'done') {
        return (
            <Card>
                <CardContent className="pt-6">
                    <p className="text-center text-sm text-green-600">
                        ✓ Password changed
                    </p>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="mt-8">
            <CardHeader>
                <CardTitle>Change password</CardTitle>
                <CardDescription>
                    Replaces the credential that derives all your encryption
                    keys. Other devices will be signed out and need to sign in
                    again with the new password.
                </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                <div>
                    <label
                        htmlFor="current-password"
                        className="mb-1 block text-sm font-medium"
                    >
                        Current password or recovery phrase
                    </label>
                    <PasswordInput
                        id="current-password"
                        value={currentPassword}
                        onChange={onCurrentChange}
                        autoComplete="current-password"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                        Accounts created before password support migrate to a
                        password the first time you change it — enter your
                        12-word recovery phrase here.
                    </p>
                </div>

                <div>
                    <label
                        htmlFor="new-password"
                        className="mb-1 block text-sm font-medium"
                    >
                        New password
                    </label>
                    <PasswordInput
                        id="new-password"
                        value={newPassword}
                        onChange={onNewChange}
                        autoComplete="new-password"
                    />
                    {newPassword.length > 0 && (
                        <div className="mt-2">
                            <PasswordStrengthMeter
                                score={strength.score}
                                feedback={strength.feedback}
                                pwned={strength.pwned}
                                loading={strength.loading}
                            />
                        </div>
                    )}
                </div>

                <div>
                    <label
                        htmlFor="confirm-new-password"
                        className="mb-1 block text-sm font-medium"
                    >
                        Confirm new password
                    </label>
                    <PasswordInput
                        id="confirm-new-password"
                        value={confirmPassword}
                        onChange={onConfirmChange}
                        autoComplete="new-password"
                        ariaInvalid={mismatch}
                    />
                    {mismatch && (
                        <p className="mt-1 text-xs text-destructive">
                            Passwords do not match.
                        </p>
                    )}
                </div>

                <div>
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: Radix UI Checkbox handles accessibility */}
                    <label className="flex items-start gap-3">
                        <Checkbox
                            checked={acknowledged}
                            onCheckedChange={(checked) =>
                                onAcknowledgedChange(checked === true)
                            }
                        />
                        <span className="text-sm">
                            I understand that if I forget this password, my
                            account and history are unrecoverable.
                        </span>
                    </label>
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <Button
                    onClick={onSubmit}
                    disabled={!canSubmit}
                    className="w-full"
                    data-testid="change-password-submit"
                >
                    Change password
                </Button>
            </CardContent>
        </Card>
    );
}
