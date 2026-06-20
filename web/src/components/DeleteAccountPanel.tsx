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
import StatusCover from '@/components/StatusCover';
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
    const [open, setOpen] = useState(false);

    const close = () => {
        setOpen(false);
        onPasswordChange('');
        onHandleConfirmChange('');
        onAcknowledgedChange(false);
    };

    const canSubmit =
        password.length > 0 && handleConfirm === handle && acknowledged;
    const busy = step === 'verifying' || step === 'deleting' || step === 'done';

    return (
        <>
            <BlockTitle>
                <span className="text-red-500">Danger zone</span>
            </BlockTitle>
            <List strong inset>
                <ListItem
                    link
                    title={<span className="text-red-500">Delete account</span>}
                    onClick={() => setOpen(true)}
                    data-testid="delete-account-trigger"
                />
            </List>

            <Sheet
                opened={open}
                onBackdropClick={busy ? undefined : close}
                className="w-full pb-8"
            >
                <div className="max-h-[85vh] overflow-y-auto">
                    {step === 'verifying' && (
                        <StatusCover
                            label="Verifying your password…"
                            destructive
                        />
                    )}
                    {(step === 'deleting' || step === 'done') && (
                        <StatusCover
                            label="Deleting your account…"
                            destructive
                        />
                    )}

                    {step === 'enter' && (
                        <>
                            <BlockTitle>Delete account</BlockTitle>
                            <Block strong inset className="space-y-5">
                                <div className="space-y-2 text-sm">
                                    <p className="font-medium">
                                        What will be deleted
                                    </p>
                                    <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                                        <li>
                                            Your profile, contacts, conversation
                                            history, key backups, and uploaded
                                            media.
                                        </li>
                                        <li>
                                            All your sessions on every device.
                                        </li>
                                        <li>
                                            Your handle{' '}
                                            <span className="font-mono">
                                                @{handle}
                                            </span>{' '}
                                            will be reserved for 30 days, then
                                            becomes available to anyone —
                                            including, until then, not even you
                                            can re-claim it.
                                        </li>
                                    </ul>
                                    <p className="font-medium">
                                        What will not be deleted
                                    </p>
                                    <ul className="list-disc space-y-1 pl-5 text-muted-foreground">
                                        <li>
                                            Messages you've sent to others —
                                            their copies remain on their devices
                                            and in their inboxes.
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
                                        <span className="font-mono">
                                            {handle}
                                        </span>{' '}
                                        to confirm
                                    </label>
                                    <input
                                        id="delete-handle-confirm"
                                        type="text"
                                        value={handleConfirm}
                                        onChange={(e) =>
                                            onHandleConfirmChange(
                                                e.target.value,
                                            )
                                        }
                                        autoComplete="off"
                                        data-testid="delete-account-handle-confirm"
                                        className="w-full rounded border border-input bg-background px-3 py-2 text-sm"
                                    />
                                </div>

                                <Checkbox
                                    checked={acknowledged}
                                    onChange={(
                                        e: React.ChangeEvent<HTMLInputElement>,
                                    ) => onAcknowledgedChange(e.target.checked)}
                                    data-testid="delete-account-ack"
                                >
                                    <span className="ml-2 text-sm">
                                        I understand this cannot be undone.
                                    </span>
                                </Checkbox>

                                {error && (
                                    <p className="text-sm text-red-500">
                                        {error}
                                    </p>
                                )}
                            </Block>
                            <Block className="flex gap-3">
                                <Button rounded clear onClick={close}>
                                    Cancel
                                </Button>
                                <Button
                                    rounded
                                    colors={{
                                        fillBgIos: 'bg-red-500',
                                        fillBgMaterial: 'bg-red-500',
                                    }}
                                    onClick={onSubmit}
                                    disabled={!canSubmit}
                                    data-testid="delete-account-submit"
                                >
                                    Delete account
                                </Button>
                            </Block>
                        </>
                    )}
                </div>
            </Sheet>
        </>
    );
}
