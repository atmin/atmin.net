import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
    APIError,
    KeyVersionStaleError,
    type RotateKeysRequest,
    rotateKeys,
    storeGet,
} from '@/lib/api';
import { argonStretch } from '@/lib/argon2-worker.client';
import { clearSession, type Session, saveSession } from '@/lib/auth';
import { deriveSecretFromPassword } from '@/lib/credential';
import {
    base64UrlEncode,
    DEFAULT_KDF,
    deriveKeys,
    generateSalt,
    type KdfParams,
    signContinuity,
} from '@/lib/crypto';
import { appendChainLink, buildChainLink } from '@/lib/key-chain';
import { path } from '@/lib/paths';

export type RotateStep =
    | 'enter'
    | 'deriving-old'
    | 'deriving-new'
    | 'writing-chain'
    | 'rotating'
    | 'done';

export interface RotateState {
    step: RotateStep;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    acknowledged: boolean;
    error: string | null;
    setCurrent: (v: string) => void;
    setNew: (v: string) => void;
    setConfirm: (v: string) => void;
    setAcknowledged: (v: boolean) => void;
    submit: () => Promise<void>;
}

function randomUUID(): string {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; // v4
    b[8] = (b[8] & 0x3f) | 0x80;
    const h = Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * "Change password" orchestrator. Owns the multi-step rotation flow
 * described in ADR-0012: derive the OLD key from the user's current
 * password, derive a fresh key from the new password, write the chain
 * link that ties them together, then call POST /v1/rotate-keys with a
 * continuity signature from the old auth key. On success, swap the
 * in-memory session for the freshly-minted one.
 *
 * `onSuccess` is wired to useSession's handleLogin upstream so the
 * whole app re-renders with the new token, new sharing key, and new
 * key_version.
 */
export function useRotateKeys(
    session: Session,
    onSuccess: (next: Session) => void,
): RotateState {
    const navigate = useNavigate();
    const [step, setStep] = useState<RotateStep>('enter');
    const [currentPassword, setCurrent] = useState('');
    const [newPassword, setNew] = useState('');
    const [confirmPassword, setConfirm] = useState('');
    const [acknowledged, setAcknowledged] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const submit = async () => {
        setError(null);
        try {
            // One read of the user's own profile.json gives us everything we
            // need: salt + kdf to derive the old key, auth_public_key to
            // verify the current credential before any new-key work, and
            // key_version to compute the next.
            const profile = await readOwnProfile(session.token, session.userId);
            const currentKV = profile.keyVersion;

            // 1. Derive the OLD keys from the current password and the stored
            //    Argon2id params. Extractable on the backup key so it can be
            //    wrapped into the chain link in step 3, then dropped.
            setStep('deriving-old');
            const oldSecret = await deriveSecretFromPassword(currentPassword, {
                salt: profile.salt,
                kdf: profile.kdf,
            });
            const oldKeys = await deriveKeys(oldSecret, { extractable: true });

            // Sanity check: derived pubkey must match what's published.
            // Mismatch means the entered current password is wrong — surface
            // it BEFORE doing the new-password derivation, no server calls.
            if (
                base64UrlEncode(oldKeys.auth.publicKeyBytes) !==
                profile.authPublicKey
            ) {
                setError('Current password is incorrect.');
                setStep('enter');
                return;
            }

            // 2. Derive the NEW keys with a fresh salt.
            setStep('deriving-new');
            const newSalt = generateSalt();
            const newSecret = await argonStretch(
                newPassword,
                newSalt,
                DEFAULT_KDF,
            );
            const newKeys = await deriveKeys(newSecret, { extractable: true });
            const newKV = currentKV + 1;

            // 3. Write the chain link BEFORE rotating, per ADR-0012. An
            //    orphaned link (if step 4 fails) is harmless — it can't
            //    decrypt anything until a future rotation matches it.
            setStep('writing-chain');
            const link = await buildChainLink(
                currentKV,
                newKV,
                oldKeys.backupKey,
                newKeys.backupKey,
            );
            await appendChainLink(session.token, session.userId, link);

            // 4. Build the rotate-keys body, sign the JCS-canonical form
            //    with the OLD auth key, POST it.
            setStep('rotating');
            const reqBody: Omit<RotateKeysRequest, 'continuity_signature'> = {
                request_id: randomUUID(),
                key_version: newKV,
                auth_public_key: base64UrlEncode(newKeys.auth.publicKeyBytes),
                sharing_public_key: base64UrlEncode(
                    newKeys.sharing.publicKeyBytes,
                ),
                salt: base64UrlEncode(newSalt),
                kdf: DEFAULT_KDF,
            };
            const sig = await signContinuity(
                oldKeys.auth.privateKey,
                reqBody as unknown as Record<string, unknown>,
            );
            const res = await rotateKeys(session.token, {
                ...reqBody,
                continuity_signature: base64UrlEncode(sig),
            });

            // 5. Swap session in place. The new backup key in IDB is the
            //    non-extractable variant we re-derive here from the same
            //    secret — the extractable one used for the chain link is
            //    dropped as `newSecret` goes out of scope.
            const persistedKeys = await deriveKeys(newSecret);
            const next: Session = {
                ...session,
                token: res.token,
                keyVersion: res.key_version,
                sharingPrivateKey: persistedKeys.sharing.privateKey,
                sharingPublicKeyBytes: persistedKeys.sharing.publicKeyBytes,
                backupKey: persistedKeys.backupKey,
            };
            await saveSession(next);
            onSuccess(next);

            // Reset form, show confirmation briefly.
            setCurrent('');
            setNew('');
            setConfirm('');
            setAcknowledged(false);
            setStep('done');
            setTimeout(() => setStep('enter'), 1500);
        } catch (e) {
            if (e instanceof KeyVersionStaleError) {
                // Another device rotated first. Local state is from a
                // superseded key_version — wipe and force re-login.
                await clearSession();
                navigate('/login');
                return;
            }
            if (e instanceof APIError) {
                setError(`Rotation failed: ${e.code}`);
            } else if (e instanceof Error) {
                setError(`Rotation failed: ${e.message}`);
            } else {
                setError('Rotation failed.');
            }
            setStep('enter');
        }
    };

    return {
        step,
        currentPassword,
        newPassword,
        confirmPassword,
        acknowledged,
        error,
        setCurrent,
        setNew,
        setConfirm,
        setAcknowledged,
        submit,
    };
}

interface RotateProfile {
    authPublicKey: string;
    salt?: string;
    kdf?: KdfParams;
    keyVersion: number;
}

async function readOwnProfile(
    token: string,
    userId: string,
): Promise<RotateProfile> {
    const blob = await storeGet(token, path.profile(userId));
    const raw = JSON.parse(new TextDecoder().decode(blob)) as {
        auth_public_key?: string;
        salt?: string;
        kdf?: KdfParams;
        key_version?: number;
    };
    return {
        authPublicKey: raw.auth_public_key ?? '',
        salt: raw.salt,
        kdf: raw.kdf,
        keyVersion: raw.key_version ?? 1,
    };
}
