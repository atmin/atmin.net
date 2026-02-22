import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { useCallback, useEffect, useState } from 'react';
import {
    type DeviceInfo,
    listDevices,
    type RevokeDeviceRequest,
    revokeDevice,
} from '@/lib/api';
import { base64UrlEncode, deriveKeys, signAuthProof } from '@/lib/crypto';

export interface DevicesState {
    devices: DeviceInfo[];
    loading: boolean;
    error: string | null;
    revoking: string | null;
    mnemonicInput: string;
    revokeError: string | null;
    setRevoking: (deviceId: string | null) => void;
    setMnemonicInput: (value: string) => void;
    handleRevoke: (deviceId: string) => Promise<void>;
}

export function useDevices(token: string, userId: string): DevicesState {
    const [devices, setDevices] = useState<DeviceInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [revoking, setRevokingRaw] = useState<string | null>(null);
    const [mnemonicInput, setMnemonicInput] = useState('');
    const [revokeError, setRevokeError] = useState<string | null>(null);

    const fetchDevices = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const list = await listDevices(token, userId);
            setDevices(list);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load devices');
        } finally {
            setLoading(false);
        }
    }, [token, userId]);

    useEffect(() => {
        fetchDevices();
    }, [fetchDevices]);

    const setRevoking = (deviceId: string | null) => {
        setRevokingRaw(deviceId);
        setRevokeError(null);
        setMnemonicInput('');
    };

    const handleRevoke = async (deviceId: string) => {
        setRevokeError(null);
        try {
            const entropy = mnemonicToEntropy(mnemonicInput.trim(), wordlist);
            const keys = await deriveKeys(new Uint8Array(entropy));

            const payload = {
                user_id: userId,
                device_id: deviceId,
                timestamp: new Date().toISOString(),
            };
            const signature = await signAuthProof(
                keys.auth.privateKey,
                payload,
            );

            const req: RevokeDeviceRequest = {
                device_id: deviceId,
                auth_proof: {
                    payload,
                    signature: base64UrlEncode(signature),
                },
            };

            await revokeDevice(token, req);
            setRevokingRaw(null);
            setMnemonicInput('');
            await fetchDevices();
        } catch (e) {
            setRevokeError(
                e instanceof Error ? e.message : 'Failed to revoke device',
            );
        }
    };

    return {
        devices,
        loading,
        error,
        revoking,
        mnemonicInput,
        revokeError,
        setRevoking,
        setMnemonicInput,
        handleRevoke,
    };
}
