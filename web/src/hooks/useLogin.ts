import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ulid } from 'ulid';
import { addDevice, resolve } from '@/lib/api';
import { type Session, saveSession } from '@/lib/auth';
import { base64UrlEncode, deriveKeys, signAuthProof } from '@/lib/crypto';
import { detectDeviceLabel } from '@/lib/utils';

export interface LoginState {
    loading: boolean;
    error: string;
    handleLogin: (inviteHandle: string, mnemonic: string) => Promise<void>;
}

export function useLogin(onSuccess: (session: Session) => void): LoginState {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleLogin = async (inviteHandle: string, mnemonic: string) => {
        setLoading(true);
        setError('');

        try {
            // Resolve invite handle to get user_id
            const resolveRes = await resolve(inviteHandle.trim());
            const userId = resolveRes.user_id;

            // Derive keys from mnemonic
            const entropy = mnemonicToEntropy(mnemonic.trim(), wordlist);
            const keys = await deriveKeys(new Uint8Array(entropy));

            // Generate new device ID
            const deviceId = ulid();

            // Create and sign auth proof
            const payload = {
                user_id: userId,
                device_id: deviceId,
                timestamp: new Date().toISOString(),
            };
            const signature = await signAuthProof(
                keys.auth.privateKey,
                payload,
            );

            // Add device
            const deviceRes = await addDevice({
                user_id: userId,
                device_label: detectDeviceLabel(),
                auth_proof: {
                    payload,
                    signature: base64UrlEncode(signature),
                },
            });

            // Save session
            const session: Session = {
                token: deviceRes.token,
                userId,
                deviceId: deviceRes.device_id,
                inviteHandle: inviteHandle.trim(),
                sharingPrivateKey: keys.sharing.privateKey,
                sharingPublicKeyBytes: keys.sharing.publicKeyBytes,
                backupKey: keys.backupKey,
            };

            await saveSession(session);
            onSuccess(session);

            // Redirect to home
            navigate('/');
        } catch (e) {
            if (e instanceof Error) {
                setError(e.message);
            } else {
                setError(
                    'Login failed. Please check your invite handle and recovery phrase.',
                );
            }
            setLoading(false);
        }
    };

    return { loading, error, handleLogin };
}
