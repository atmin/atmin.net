import { useState } from 'react';
import { APIError, register } from '@/lib/api';
import { argonStretch } from '@/lib/argon2-worker.client';
import { type Session, saveSession } from '@/lib/auth';
import {
    base64UrlEncode,
    DEFAULT_KDF,
    deriveKeys,
    generateSalt,
} from '@/lib/crypto';
import { detectDeviceLabel } from '@/lib/utils';

export type RegisterStep = 'enter' | 'deriving' | 'registering' | 'done';

export interface RegisterState {
    step: RegisterStep;
    handle: string;
    password: string;
    confirm: string;
    acknowledged: boolean;
    error: string;
    setHandle: (value: string) => void;
    setPassword: (value: string) => void;
    setConfirm: (value: string) => void;
    setAcknowledged: (value: boolean) => void;
    handleRegister: () => Promise<void>;
}

// Maps the server's handle-related error codes to user-facing messages.
// Other codes fall through to the generic "Registration failed" path.
function handleRegisterError(err: unknown): string | null {
    if (!(err instanceof APIError)) return null;
    switch (err.code) {
        case 'handle_invalid':
            return 'Handle must be 3–32 lowercase letters, digits, or hyphens, starting with a letter.';
        case 'handle_reserved':
            return 'That handle is reserved. Pick another one.';
        case 'handle_taken':
            return 'That handle is already taken.';
        case 'handle_in_cooldown':
            return 'That handle was recently deleted and is in 30-day cooldown.';
        case 'registration_unavailable':
            return 'Registration is temporarily busy — please retry.';
        default:
            return null;
    }
}

export function useRegister(
    onSuccess: (session: Session) => void,
): RegisterState {
    const [step, setStep] = useState<RegisterStep>('enter');
    const [handle, setHandle] = useState('');
    const [password, setPassword] = useState('');
    const [confirm, setConfirm] = useState('');
    const [acknowledged, setAcknowledged] = useState(false);
    const [error, setError] = useState('');

    const handleRegister = async () => {
        setError('');
        setStep('deriving');

        try {
            // Argon2id stretch (~3-4s on a mid-tier device, off the main
            // thread) → 16-byte secret → existing HKDF chain.
            const salt = generateSalt();
            const secret = await argonStretch(password, salt, DEFAULT_KDF);
            const keys = await deriveKeys(secret);

            setStep('registering');
            const res = await register({
                handle: handle.trim().toLowerCase(),
                device_label: detectDeviceLabel(),
                auth_public_key: base64UrlEncode(keys.auth.publicKeyBytes),
                sharing_public_key: base64UrlEncode(
                    keys.sharing.publicKeyBytes,
                ),
                salt: base64UrlEncode(salt),
                kdf: DEFAULT_KDF,
            });

            const session: Session = {
                token: res.token,
                userId: res.user_id,
                deviceId: res.device_id,
                handle: res.handle,
                sharingPrivateKey: keys.sharing.privateKey,
                sharingPublicKeyBytes: keys.sharing.publicKeyBytes,
                backupKey: keys.backupKey,
                // Fresh v2 accounts start at key_version 1; v1 accounts also
                // ride implicit kv=1 (their profile omits the field).
                keyVersion: 1,
            };

            await saveSession(session);
            onSuccess(session);
            setStep('done');
        } catch (e) {
            const mapped = handleRegisterError(e);
            if (mapped) {
                setError(mapped);
            } else {
                setError(`Registration failed: ${e}`);
            }
            setStep('enter');
        }
    };

    return {
        step,
        handle,
        password,
        confirm,
        acknowledged,
        error,
        setHandle,
        setPassword,
        setConfirm,
        setAcknowledged,
        handleRegister,
    };
}
