import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { APIError, deleteProfile, storeGet } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { deriveSecretFromPassword } from '@/lib/credential';
import { base64UrlEncode, deriveKeys, type KdfParams } from '@/lib/crypto';
import { path } from '@/lib/paths';

export type DeleteStep = 'enter' | 'verifying' | 'deleting' | 'done';

export interface DeleteState {
    step: DeleteStep;
    password: string;
    handleConfirm: string;
    acknowledged: boolean;
    error: string | null;
    setPassword: (v: string) => void;
    setHandleConfirm: (v: string) => void;
    setAcknowledged: (v: boolean) => void;
    submit: () => Promise<void>;
}

/**
 * "Delete account" orchestrator. Gates the destructive call behind a
 * cryptographic password check (re-derive the auth key from the entered
 * password and compare it to the published one — the same defence-in-depth as
 * change-password, so a stolen unlocked device can't delete the account and
 * the password never leaves the device). On success the server wipes all
 * per-user data and writes a 30-day handle tombstone; `onDeleted` (wired to
 * useSession) drops the in-memory session, wipes local IndexedDB, and raises
 * the one-shot confirmation that renders on Landing.
 */
export function useDeleteAccount(
    session: Session,
    onDeleted: () => void | Promise<void>,
): DeleteState {
    const navigate = useNavigate();
    const [step, setStep] = useState<DeleteStep>('enter');
    const [password, setPassword] = useState('');
    const [handleConfirm, setHandleConfirm] = useState('');
    const [acknowledged, setAcknowledged] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        setError(null);
        try {
            // 1. Verify the password locally — no server round-trip on a wrong
            //    password (same property as useRotateKeys).
            setStep('verifying');
            const profile = await readOwnProfile(session.token, session.userId);
            const secret = await deriveSecretFromPassword(password, {
                salt: profile.salt,
                kdf: profile.kdf,
            });
            const keys = await deriveKeys(secret);
            if (
                base64UrlEncode(keys.auth.publicKeyBytes) !==
                profile.authPublicKey
            ) {
                setError('Password is incorrect.');
                setStep('enter');
                return;
            }

            // 2. Server-side delete.
            setStep('deleting');
            await deleteProfile(session.token);
        } catch (e) {
            // A 401 anywhere means another device's delete won the race — the
            // account is already gone, so proceed as if successful. Anything
            // else (profile read failure, 5xx during delete) is recoverable:
            // surface it and keep the session so the user can retry.
            if (!(e instanceof APIError && e.status === 401)) {
                setError('Could not delete account. Please try again.');
                setStep('enter');
                return;
            }
        }

        // 3. Wipe local state + sign out + raise the confirmation. Navigate to
        //    Landing first (still authenticated for a tick) so the session-null
        //    re-render lands there rather than bouncing through /login.
        setStep('done');
        navigate('/', { replace: true });
        await onDeleted();
    };

    return {
        step,
        password,
        handleConfirm,
        acknowledged,
        error,
        setPassword,
        setHandleConfirm,
        setAcknowledged,
        submit,
    };
}

interface OwnProfile {
    authPublicKey: string;
    salt?: string;
    kdf?: KdfParams;
}

async function readOwnProfile(
    token: string,
    userId: string,
): Promise<OwnProfile> {
    const blob = await storeGet(token, path.profile(userId));
    const raw = JSON.parse(new TextDecoder().decode(blob)) as {
        auth_public_key?: string;
        salt?: string;
        kdf?: KdfParams;
    };
    return {
        authPublicKey: raw.auth_public_key ?? '',
        salt: raw.salt,
        kdf: raw.kdf,
    };
}
