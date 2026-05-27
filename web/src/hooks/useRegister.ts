import { useState } from 'react';
import { register } from '@/lib/api';
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
    password: string;
    confirm: string;
    acknowledged: boolean;
    error: string;
    setPassword: (value: string) => void;
    setConfirm: (value: string) => void;
    setAcknowledged: (value: boolean) => void;
    handleRegister: () => Promise<void>;
}

export function useRegister(
    onSuccess: (session: Session) => void,
): RegisterState {
    const [step, setStep] = useState<RegisterStep>('enter');
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
            };

            await saveSession(session);
            onSuccess(session);
            setStep('done');
        } catch (e) {
            setError(`Registration failed: ${e}`);
            setStep('enter');
        }
    };

    return {
        step,
        password,
        confirm,
        acknowledged,
        error,
        setPassword,
        setConfirm,
        setAcknowledged,
        handleRegister,
    };
}
