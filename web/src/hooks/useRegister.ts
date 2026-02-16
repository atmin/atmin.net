import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { register } from '@/lib/api';
import { type Session, saveSession } from '@/lib/auth';
import {
    base64UrlEncode,
    deriveKeys,
    generateBackupSecret,
} from '@/lib/crypto';
import { detectDeviceLabel } from '@/lib/utils';

export type RegisterStep = 'generate' | 'registering' | 'done';

export interface RegisterState {
    step: RegisterStep;
    mnemonic: string;
    error: string;
    handleRegister: () => Promise<void>;
}

export function useRegister(
    onSuccess: (session: Session) => void,
): RegisterState {
    const navigate = useNavigate();
    const [step, setStep] = useState<RegisterStep>('generate');
    const [mnemonic, setMnemonic] = useState('');
    const [error, setError] = useState('');

    // Generate mnemonic on first render
    if (!mnemonic) {
        const secret = generateBackupSecret();
        const m = entropyToMnemonic(secret, wordlist);
        setMnemonic(m);
    }

    const handleRegister = async () => {
        setStep('registering');
        setError('');

        try {
            const entropy = mnemonicToEntropy(mnemonic, wordlist);
            const keys = await deriveKeys(new Uint8Array(entropy));

            const res = await register({
                device_label: detectDeviceLabel(),
                auth_public_key: base64UrlEncode(keys.auth.publicKeyBytes),
                sharing_public_key: base64UrlEncode(
                    keys.sharing.publicKeyBytes,
                ),
            });

            const session: Session = {
                token: res.token,
                userId: res.user_id,
                deviceId: res.device_id,
                inviteHandle: res.invite_handle,
                sharingPrivateKey: keys.sharing.privateKey,
                sharingPublicKeyBytes: keys.sharing.publicKeyBytes,
                backupKey: keys.backupKey,
            };

            await saveSession(session);
            onSuccess(session);
            setStep('done');

            // Redirect to home after short delay
            setTimeout(() => navigate('/'), 1000);
        } catch (e) {
            setError(`Registration failed: ${e}`);
            setStep('generate');
        }
    };

    return { step, mnemonic, error, handleRegister };
}
