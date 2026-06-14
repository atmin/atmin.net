import { useCallback, useEffect, useRef, useState } from 'react';
import {
    APIError,
    getRegisterChallenge,
    type PowProof,
    type RegisterResponse,
    register,
} from '@/lib/api';
import { argonStretch, solvePow } from '@/lib/argon2-worker.client';
import { type Session, saveSession } from '@/lib/auth';
import {
    base64UrlEncode,
    DEFAULT_KDF,
    deriveKeys,
    generateSalt,
} from '@/lib/crypto';
import { detectDeviceLabel } from '@/lib/utils';

export type RegisterStep =
    | 'enter'
    | 'deriving'
    | 'proving'
    | 'registering'
    | 'done';

// Background proof-of-work status, surfaced on the form so the user knows the
// (prefetched) anti-abuse work is happening while they type (ADR-0020).
export type PowStatus = 'solving' | 'ready' | 'failed';

export interface RegisterState {
    step: RegisterStep;
    handle: string;
    password: string;
    confirm: string;
    acknowledged: boolean;
    error: string;
    // Proof-of-work telemetry. `powStatus` drives the form's "preparing/ready"
    // line; `provingMs` ticks live while the PoW solves (from form mount) then
    // freezes at the total; `powHashes` is the attempts it took (≈ counter + 1).
    powStatus: PowStatus;
    provingMs: number;
    powHashes: number;
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
        case 'pow_invalid':
            // The challenge is single-use; a fresh submit fetches a new one.
            return 'Registration check failed — please try again.';
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
    const [powStatus, setPowStatus] = useState<PowStatus>('solving');
    const [provingMs, setProvingMs] = useState(0);
    const [powHashes, setPowHashes] = useState(0);

    // The in-flight (or settled) proof-of-work, and the live-timer interval.
    const powRef = useRef<Promise<PowProof> | null>(null);
    const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
    const startedRef = useRef(false);

    // Fetch a challenge and solve it (single worker, shared with the credential
    // KDF — so they serialize, which is fine for a once-per-handle cost). Ticks
    // the elapsed timer for the on-screen counter, and records status/attempts.
    const runPow = useCallback((): Promise<PowProof> => {
        setPowStatus('solving');
        const t0 = performance.now();
        if (tickRef.current) clearInterval(tickRef.current);
        tickRef.current = setInterval(
            () => setProvingMs(performance.now() - t0),
            100,
        );
        const promise = (async (): Promise<PowProof> => {
            const challenge = await getRegisterChallenge();
            const counter = await solvePow(challenge);
            return { nonce: challenge.nonce, counter };
        })();
        powRef.current = promise;
        promise
            .then((p) => {
                setPowHashes(p.counter + 1);
                setPowStatus('ready');
            })
            .catch(() => {
                powRef.current = null; // submit will solve inline
                setPowStatus('failed');
            })
            .finally(() => {
                if (tickRef.current) clearInterval(tickRef.current);
                tickRef.current = null;
                setProvingMs(performance.now() - t0);
            });
        return promise;
    }, []);

    // Prefetch + solve on mount, so the PoW runs while the user fills the form
    // and is usually done before they submit. Guarded against React's double
    // invoke so we don't burn two challenges.
    useEffect(() => {
        if (startedRef.current) return;
        startedRef.current = true;
        void runPow();
    }, [runPow]);

    // Stop the live timer if the form unmounts mid-solve.
    useEffect(
        () => () => {
            if (tickRef.current) clearInterval(tickRef.current);
        },
        [],
    );

    const handleRegister = async () => {
        setError('');

        try {
            // 1) Proof-of-work first. Reuse the prefetch (usually already solved);
            //    if it's still running we show the proving step + live counter, and
            //    awaiting it here frees the single worker for the KDF next (so the
            //    "Deriving…" label isn't secretly stuck behind a running PoW).
            if (powStatus !== 'ready') setStep('proving');
            let proof: PowProof;
            try {
                proof = await (powRef.current ?? runPow());
            } catch {
                proof = await runPow(); // prefetch failed → solve inline
            }

            // 2) Credential KDF — needs the password, so it runs now. Worker free.
            setStep('deriving');
            const salt = generateSalt();
            const secret = await argonStretch(password, salt, DEFAULT_KDF);
            const keys = await deriveKeys(secret);

            const buildBody = (pow: PowProof) => ({
                handle: handle.trim().toLowerCase(),
                device_label: detectDeviceLabel(),
                auth_public_key: base64UrlEncode(keys.auth.publicKeyBytes),
                sharing_public_key: base64UrlEncode(
                    keys.sharing.publicKeyBytes,
                ),
                salt: base64UrlEncode(salt),
                kdf: DEFAULT_KDF,
                pow,
            });

            // 3) Register, retrying once if a long-prefetched nonce expired (TTL).
            setStep('registering');
            let res: RegisterResponse;
            try {
                res = await register(buildBody(proof));
            } catch (e) {
                if (e instanceof APIError && e.code === 'pow_invalid') {
                    setStep('proving');
                    proof = await runPow();
                    setStep('registering');
                    res = await register(buildBody(proof));
                } else {
                    throw e;
                }
            }

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
        powStatus,
        provingMs,
        powHashes,
        setHandle,
        setPassword,
        setConfirm,
        setAcknowledged,
        handleRegister,
    };
}
