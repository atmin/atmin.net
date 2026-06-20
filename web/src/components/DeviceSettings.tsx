import {
    Badge,
    Block,
    BlockTitle,
    Dialog,
    DialogButton,
    List,
    ListItem,
} from 'konsta/react';
import type { DeviceInfo } from '@/lib/api';

interface Props {
    devices: DeviceInfo[];
    currentDeviceId: string;
    loading: boolean;
    error: string | null;
    revoking: string | null;
    secretInput: string;
    revokeError: string | null;
    onStartRevoke: (deviceId: string) => void;
    onCancelRevoke: () => void;
    onSecretChange: (value: string) => void;
    onConfirmRevoke: (deviceId: string) => void;
}

export default function DeviceSettings({
    devices,
    currentDeviceId,
    loading,
    error,
    revoking,
    secretInput,
    revokeError,
    onStartRevoke,
    onCancelRevoke,
    onSecretChange,
    onConfirmRevoke,
}: Props) {
    const revokingDevice = devices.find((d) => d.device_id === revoking);

    return (
        <>
            <BlockTitle>Devices</BlockTitle>
            {loading && (
                <Block className="text-sm opacity-60">Loading devices…</Block>
            )}
            {error && <Block className="text-sm text-red-500">{error}</Block>}

            {!loading && devices.length > 0 && (
                <List strong inset data-testid="device-list">
                    {devices.map((device) => {
                        const isCurrent = device.device_id === currentDeviceId;
                        return (
                            <ListItem
                                key={device.device_id}
                                data-testid="device-item"
                                title={device.device_label}
                                text={`Added ${new Date(
                                    device.created_at,
                                ).toLocaleDateString()}`}
                                after={
                                    isCurrent ? (
                                        <Badge>this device</Badge>
                                    ) : (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onStartRevoke(device.device_id)
                                            }
                                            className="text-sm text-red-500 active:opacity-60"
                                            data-testid="revoke-button"
                                        >
                                            Revoke
                                        </button>
                                    )
                                }
                            />
                        );
                    })}
                </List>
            )}

            <Dialog
                opened={!!revoking}
                onBackdropClick={onCancelRevoke}
                // Konsta's iOS Dialog draws its surface from the Glass component,
                // whose `glass` style is trimmed from our theme (ADR-0023 / T0),
                // so iOS rendered transparent. Give it the explicit frosted
                // surface (same recipe as the overlays / actions sheet); Material
                // keeps its tonal surface-3 default.
                colors={{
                    bgIos: 'bg-white/90 backdrop-blur-xl dark:bg-[#1c1c1e]/90',
                }}
                title={
                    revokingDevice
                        ? `Revoke “${revokingDevice.device_label}”?`
                        : 'Revoke device?'
                }
                content={
                    <div className="space-y-2 py-1 text-left">
                        <p className="text-sm">
                            Enter your password or recovery phrase to confirm.
                        </p>
                        <input
                            type="password"
                            value={secretInput}
                            onChange={(e) => onSecretChange(e.target.value)}
                            placeholder="Password or recovery phrase"
                            data-testid="credential-input"
                            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none"
                        />
                        {revokeError && (
                            <p className="text-sm text-red-500">
                                {revokeError}
                            </p>
                        )}
                    </div>
                }
                buttons={
                    <>
                        <DialogButton onClick={onCancelRevoke}>
                            Cancel
                        </DialogButton>
                        <DialogButton
                            strong
                            disabled={!secretInput.trim()}
                            onClick={() =>
                                revoking && onConfirmRevoke(revoking)
                            }
                            data-testid="confirm-revoke"
                        >
                            Revoke
                        </DialogButton>
                    </>
                }
            />
        </>
    );
}
