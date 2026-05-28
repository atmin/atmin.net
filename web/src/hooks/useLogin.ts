import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ulid } from 'ulid';
import { addDevice, resolve } from '@/lib/api';
import { type Session, saveSession } from '@/lib/auth';
import { deriveSecretFromCredential } from '@/lib/credential';
import {
    base64UrlEncode,
    deriveKeys,
    signAuthProof,
    signAuthProofV2,
} from '@/lib/crypto';
import { detectDeviceLabel } from '@/lib/utils';

// Re-exported for tests; the canonical definition lives in lib/credential.
export { isLegacyMnemonic } from '@/lib/credential';

export interface LoginState {
    loading: boolean;
    error: string;
    handleLogin: (handle: string, secret: string) => Promise<void>;
}

export function useLogin(onSuccess: (session: Session) => void): LoginState {
    const navigate = useNavigate();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleLogin = async (handle: string, secretInput: string) => {
        setLoading(true);
        setError('');

        try {
            // Handles are lowercase ASCII (ADR-0013); normalise here so a
            // user typing "Alice-Test" doesn't hit a misleading 404.
            const normalisedHandle = handle.trim().toLowerCase();
            const resolveRes = await resolve(normalisedHandle);
            if (resolveRes.status === 'not_found') {
                setError('No account with that handle.');
                setLoading(false);
                return;
            }
            if (resolveRes.status === 'released') {
                const date = resolveRes.released_at
                    ? new Date(resolveRes.released_at)
                          .toISOString()
                          .slice(0, 10)
                    : 'recently';
                setError(`That account was deleted on ${date}.`);
                setLoading(false);
                return;
            }
            const userId = resolveRes.user_id;

            const derivedSecret = await deriveSecretFromCredential(
                secretInput,
                {
                    salt: resolveRes.salt,
                    kdf: resolveRes.kdf,
                },
            );
            const profileKeyVersion = resolveRes.key_version ?? 1;

            const keys = await deriveKeys(derivedSecret);

            const deviceId = ulid();

            // v2 auth proof (JCS-canonicalized, carries key_version) only
            // once an account has rotated; v2 accounts still at key_version 1
            // match v1's implicit kv=1, so v1 is correct there too.
            const payload = {
                user_id: userId,
                device_id: deviceId,
                timestamp: new Date().toISOString(),
                ...(profileKeyVersion > 1
                    ? { key_version: profileKeyVersion }
                    : {}),
            };
            const signature =
                profileKeyVersion > 1
                    ? await signAuthProofV2(keys.auth.privateKey, {
                          ...payload,
                          key_version: profileKeyVersion,
                      })
                    : await signAuthProof(keys.auth.privateKey, payload);

            const deviceRes = await addDevice({
                user_id: userId,
                device_label: detectDeviceLabel(),
                auth_proof: {
                    payload,
                    signature: base64UrlEncode(signature),
                },
            });

            const session: Session = {
                token: deviceRes.token,
                userId,
                deviceId: deviceRes.device_id,
                handle: normalisedHandle,
                sharingPrivateKey: keys.sharing.privateKey,
                sharingPublicKeyBytes: keys.sharing.publicKeyBytes,
                backupKey: keys.backupKey,
                keyVersion: profileKeyVersion,
            };

            await saveSession(session);
            onSuccess(session);

            navigate('/');
        } catch (e) {
            if (e instanceof Error) {
                setError(e.message);
            } else {
                setError(
                    'Login failed. Please check your handle and password.',
                );
            }
            setLoading(false);
        }
    };

    return { loading, error, handleLogin };
}
