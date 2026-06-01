import { useState } from 'react';
import PasswordInput from '@/components/PasswordInput';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import type { DeleteStep } from '@/hooks/useDeleteAccount';

interface Props {
    handle: string;
    step: DeleteStep;
    password: string;
    handleConfirm: string;
    acknowledged: boolean;
    error: string | null;
    onPasswordChange: (v: string) => void;
    onHandleConfirmChange: (v: string) => void;
    onAcknowledgedChange: (v: boolean) => void;
    onSubmit: () => void;
}

function StepCover({ label }: { label: string }) {
    return (
        <Card className="mt-8 border-destructive/40">
            <CardContent className="pt-6 text-center">
                <div className="mb-4 flex justify-center gap-2">
                    <span className="size-3 animate-pulse rounded-full bg-destructive [animation-delay:-0.3s]" />
                    <span className="size-3 animate-pulse rounded-full bg-destructive [animation-delay:-0.15s]" />
                    <span className="size-3 animate-pulse rounded-full bg-destructive" />
                </div>
                <p className="text-sm font-medium">{label}</p>
            </CardContent>
        </Card>
    );
}

export default function DeleteAccountPanel({
    handle,
    step,
    password,
    handleConfirm,
    acknowledged,
    error,
    onPasswordChange,
    onHandleConfirmChange,
    onAcknowledgedChange,
    onSubmit,
}: Props) {
    const [expanded, setExpanded] = useState(false);

    if (step === 'verifying') {
        return <StepCover label="Verifying your password…" />;
    }
    if (step === 'deleting' || step === 'done') {
        return <StepCover label="Deleting your account…" />;
    }

    const cancel = () => {
        setExpanded(false);
        onPasswordChange('');
        onHandleConfirmChange('');
        onAcknowledgedChange(false);
    };

    const canSubmit =
        password.length > 0 && handleConfirm === handle && acknowledged;

    if (!expanded) {
        return (
            <Card className="mt-8 border-destructive/40">
                <CardHeader>
                    <CardTitle className="text-destructive">
                        Delete account
                    </CardTitle>
                    <CardDescription>
                        Permanently delete @{handle} and all your data. This
                        cannot be undone. Want to leave on just this device?
                        Sign out from Devices instead.
                    </CardDescription>
                </CardHeader>
                <CardContent>
                    <Button
                        variant="outline"
                        onClick={() => setExpanded(true)}
                        data-testid="delete-account-trigger"
                        className="border-destructive/50 text-destructive hover:bg-destructive/10"
                    >
                        Delete account
                    </Button>
                </CardContent>
            </Card>
        );
    }

    return (
        <Card className="mt-8 border-destructive/40">
            <CardHeader>
                <CardTitle className="text-destructive">
                    Delete account
                </CardTitle>
                <CardDescription>This cannot be undone.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-5">
                <div className="space-y-2 text-sm">
                    <p className="font-medium">What will be deleted</p>
                    <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                        <li>
                            Your profile, contacts, conversation history, key
                            backups, and uploaded media.
                        </li>
                        <li>All your sessions on every device.</li>
                        <li>
                            Your handle @{handle} will be reserved for 30 days,
                            then becomes available to anyone — including, until
                            then, not even you can re-claim it.
                        </li>
                    </ul>
                    <p className="font-medium">What will not be deleted</p>
                    <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                        <li>
                            Messages you've sent to others — their copies remain
                            on their devices and in their inboxes.
                        </li>
                    </ul>
                </div>

                <div>
                    <label
                        htmlFor="delete-password"
                        className="mb-1 block text-sm font-medium"
                    >
                        Password
                    </label>
                    <PasswordInput
                        id="delete-password"
                        value={password}
                        onChange={onPasswordChange}
                        autoComplete="current-password"
                    />
                </div>

                <div>
                    <label
                        htmlFor="delete-handle-confirm"
                        className="mb-1 block text-sm font-medium"
                    >
                        Type your handle{' '}
                        <span className="font-mono">{handle}</span> to confirm
                    </label>
                    <input
                        id="delete-handle-confirm"
                        type="text"
                        value={handleConfirm}
                        onChange={(e) => onHandleConfirmChange(e.target.value)}
                        autoComplete="off"
                        data-testid="delete-account-handle-confirm"
                        className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                    />
                </div>

                <div>
                    {/* biome-ignore lint/a11y/noLabelWithoutControl: Radix UI Checkbox handles accessibility */}
                    <label className="flex items-start gap-3">
                        <Checkbox
                            checked={acknowledged}
                            onCheckedChange={(checked) =>
                                onAcknowledgedChange(checked === true)
                            }
                            data-testid="delete-account-ack"
                        />
                        <span className="text-sm">
                            I understand this cannot be undone.
                        </span>
                    </label>
                </div>

                {error && <p className="text-sm text-destructive">{error}</p>}

                <div className="flex gap-3">
                    <Button
                        variant="destructive"
                        onClick={onSubmit}
                        disabled={!canSubmit}
                        data-testid="delete-account-submit"
                    >
                        Delete account
                    </Button>
                    <Button
                        variant="ghost"
                        onClick={cancel}
                        data-testid="delete-account-cancel"
                    >
                        Cancel
                    </Button>
                </div>
            </CardContent>
        </Card>
    );
}
