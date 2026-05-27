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
    return (
        <div className="mt-8">
            <h2 className="mb-4 text-lg font-bold">Devices</h2>

            {loading && (
                <p className="text-xs text-muted-foreground">
                    Loading devices...
                </p>
            )}
            {error && <p className="text-xs text-destructive">{error}</p>}

            {!loading && devices.length > 0 && (
                <ul className="space-y-3" data-testid="device-list">
                    {devices.map((device) => {
                        const isCurrent = device.device_id === currentDeviceId;
                        return (
                            <li
                                key={device.device_id}
                                className={`rounded border p-3 ${isCurrent ? 'border-ring bg-muted' : 'border-input'}`}
                                data-testid="device-item"
                            >
                                <div className="flex items-center justify-between">
                                    <div>
                                        <span className="font-medium">
                                            {device.device_label}
                                        </span>
                                        {isCurrent && (
                                            <span className="ml-2 text-xs text-muted-foreground">
                                                (this device)
                                            </span>
                                        )}
                                        <p className="text-xs text-muted-foreground">
                                            Added{' '}
                                            {new Date(
                                                device.created_at,
                                            ).toLocaleDateString()}
                                        </p>
                                    </div>
                                    {!isCurrent && (
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onStartRevoke(device.device_id)
                                            }
                                            className="text-xs text-destructive hover:underline"
                                            data-testid="revoke-button"
                                        >
                                            Revoke
                                        </button>
                                    )}
                                </div>

                                {revoking === device.device_id && (
                                    <div className="mt-3 space-y-2">
                                        <label
                                            htmlFor={`secret-${device.device_id}`}
                                            className="block text-xs text-muted-foreground"
                                        >
                                            Enter your password or recovery
                                            phrase to confirm:
                                        </label>
                                        <input
                                            id={`secret-${device.device_id}`}
                                            type="password"
                                            value={secretInput}
                                            onChange={(e) =>
                                                onSecretChange(e.target.value)
                                            }
                                            placeholder="Password or recovery phrase"
                                            className="w-full rounded border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none"
                                            data-testid="credential-input"
                                        />
                                        <div className="flex gap-2">
                                            <button
                                                type="button"
                                                onClick={() =>
                                                    onConfirmRevoke(
                                                        device.device_id,
                                                    )
                                                }
                                                disabled={!secretInput.trim()}
                                                className="rounded bg-destructive px-3 py-1 text-xs text-destructive-foreground hover:bg-destructive/90 disabled:opacity-50"
                                                data-testid="confirm-revoke"
                                            >
                                                Confirm Revoke
                                            </button>
                                            <button
                                                type="button"
                                                onClick={onCancelRevoke}
                                                className="rounded bg-secondary px-3 py-1 text-xs text-secondary-foreground hover:bg-secondary/80"
                                            >
                                                Cancel
                                            </button>
                                        </div>
                                        {revokeError && (
                                            <p className="text-xs text-destructive">
                                                {revokeError}
                                            </p>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </div>
    );
}
