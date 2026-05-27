import { useCallback, useEffect, useState } from 'react';
import {
    type DeviceInfo,
    listDevices,
    type RevokeDeviceRequest,
    revokeDevice,
    storeGet,
} from '@/lib/api';
import {
    type CredentialParams,
    deriveSecretFromCredential,
    isLegacyMnemonic,
} from '@/lib/credential';
import { base64UrlEncode, deriveKeys, signAuthProof } from '@/lib/crypto';
import { path } from '@/lib/paths';

export interface DevicesState {
    devices: DeviceInfo[];
    loading: boolean;
    error: string | null;
    revoking: string | null;
    secretInput: string;
    revokeError: string | null;
    setRevoking: (deviceId: string | null) => void;
    setSecretInput: (value: string) => void;
    handleRevoke: (deviceId: string) => Promise<void>;
}

export function useDevices(token: string, userId: string): DevicesState {
    const [devices, setDevices] = useState<DeviceInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [revoking, setRevokingRaw] = useState<string | null>(null);
    const [secretInput, setSecretInput] = useState('');
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
        setSecretInput('');
    };

    const handleRevoke = async (deviceId: string) => {
        setRevokeError(null);
        try {
            // v2 accounts need their stored Argon2id params; read them from
            // the caller's own profile.json. Legacy mnemonics skip this.
            let params: CredentialParams = {};
            if (!isLegacyMnemonic(secretInput)) {
                const blob = await storeGet(token, path.profile(userId));
                const profile = JSON.parse(
                    new TextDecoder().decode(blob),
                ) as CredentialParams;
                params = { salt: profile.salt, kdf: profile.kdf };
            }

            const secret = await deriveSecretFromCredential(
                secretInput,
                params,
            );
            const keys = await deriveKeys(secret);

            // key_version is 1 for every account until rotation ships
            // (ADR-0012, task 2), so the v1 auth proof is correct here.
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
            setSecretInput('');
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
        secretInput,
        revokeError,
        setRevoking,
        setSecretInput,
        handleRevoke,
    };
}
