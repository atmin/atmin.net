import {
    Block,
    BlockTitle,
    Button,
    Checkbox,
    List,
    ListItem,
    Sheet,
} from 'konsta/react';
import { useState } from 'react';
import PasswordInput from '@/components/PasswordInput';
import PasswordStrengthMeter from '@/components/PasswordStrengthMeter';
import StatusCover from '@/components/StatusCover';
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
    const [open, setOpen] = useState(false);

    const mismatch =
        confirmPassword.length > 0 && newPassword !== confirmPassword;
    const canSubmit =
        currentPassword.length > 0 &&
        newPassword.length > 0 &&
        newPassword === confirmPassword &&
        acknowledged &&
        step === 'enter';

    return (
        <>
            <BlockTitle>Security</BlockTitle>
            <List strong inset>
                <ListItem
                    link
                    title="Change password"
                    onClick={() => setOpen(true)}
                    data-testid="change-password-trigger"
                />
            </List>

            <Sheet
                opened={open}
                onBackdropClick={() => setOpen(false)}
                className="w-full pb-8"
            >
                <div className="max-h-[85vh] overflow-y-auto">
                    {step === 'deriving-old' && (
                        <StatusCover label="Verifying your current password…" />
                    )}
                    {step === 'deriving-new' && (
                        <StatusCover label="Deriving keys for your new password…" />
                    )}
                    {step === 'writing-chain' && (
                        <StatusCover label="Writing key chain…" />
                    )}
                    {step === 'rotating' && (
                        <StatusCover label="Rotating credentials on the server…" />
                    )}
                    {step === 'done' && (
                        <Block className="py-10 text-center text-sm text-green-600">
                            ✓ Password changed
                        </Block>
                    )}

                    {step === 'enter' && (
                        <>
                            <BlockTitle>Change password</BlockTitle>
                            <Block className="text-sm opacity-70">
                                Replaces the credential that derives all your
                                encryption keys. Other devices will be signed
                                out and need to sign in again with the new
                                password.
                            </Block>
                            <Block strong inset className="space-y-5">
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
                                        Accounts created before password support
                                        migrate to a password the first time you
                                        change it — enter your 12-word recovery
                                        phrase here.
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
                                        <p className="mt-1 text-xs text-red-500">
                                            Passwords do not match.
                                        </p>
                                    )}
                                </div>

                                <Checkbox
                                    checked={acknowledged}
                                    onChange={(
                                        e: React.ChangeEvent<HTMLInputElement>,
                                    ) => onAcknowledgedChange(e.target.checked)}
                                    data-testid="change-password-ack"
                                >
                                    <span className="ml-2 text-sm">
                                        I understand that if I forget this
                                        password, my account and history are
                                        unrecoverable.
                                    </span>
                                </Checkbox>

                                {error && (
                                    <p className="text-sm text-red-500">
                                        {error}
                                    </p>
                                )}
                            </Block>
                            <Block className="flex gap-3">
                                <Button
                                    rounded
                                    clear
                                    onClick={() => setOpen(false)}
                                >
                                    Cancel
                                </Button>
                                <Button
                                    rounded
                                    onClick={onSubmit}
                                    disabled={!canSubmit}
                                    data-testid="change-password-submit"
                                >
                                    Change password
                                </Button>
                            </Block>
                        </>
                    )}
                </div>
            </Sheet>
        </>
    );
}
