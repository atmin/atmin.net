import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { useState } from 'react';
import { register } from './api';
import { type Session, saveSession } from './auth';
import { base64UrlEncode, deriveKeys, generateBackupSecret } from './crypto';

type Step = 'generate' | 'confirm' | 'registering' | 'done';

interface Props {
    onComplete: (session: Session) => void;
}

function pickTwoIndices(): [number, number] {
    const a = Math.floor(Math.random() * 12);
    let b = Math.floor(Math.random() * 11);
    if (b >= a) b++;
    return a < b ? [a, b] : [b, a];
}

export default function Registration({ onComplete }: Props) {
    const [step, setStep] = useState<Step>('generate');
    const [mnemonic, setMnemonic] = useState('');
    const [checkIndices, setCheckIndices] = useState<[number, number]>([0, 1]);
    const [input1, setInput1] = useState('');
    const [input2, setInput2] = useState('');
    const [error, setError] = useState('');
    const [completedSession, setCompletedSession] = useState<Session | null>(
        null,
    );

    const words = mnemonic.split(' ');

    const handleGenerate = () => {
        const secret = generateBackupSecret();
        const m = entropyToMnemonic(secret, wordlist);
        setMnemonic(m);
        setCheckIndices(pickTwoIndices());
        setStep('generate');
    };

    // Generate on first render
    if (!mnemonic) handleGenerate();

    const handleConfirm = () => {
        const w1 = input1.trim().toLowerCase();
        const w2 = input2.trim().toLowerCase();
        if (w1 !== words[checkIndices[0]] || w2 !== words[checkIndices[1]]) {
            setError('Words do not match. Please try again.');
            return;
        }
        setError('');
        handleRegister();
    };

    const handleRegister = async () => {
        setStep('registering');
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
            setCompletedSession(session);
            setStep('done');
        } catch (e) {
            setError(`Registration failed: ${e}`);
            setStep('confirm');
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-stone-50 p-8">
            <div className="w-full max-w-md">
                <h1 className="mb-8 text-2xl font-bold">atmin</h1>

                {step === 'generate' && (
                    <div>
                        <p className="mb-4 text-stone-600">
                            Write down these 12 words. This is your only way to
                            recover your account.
                        </p>
                        <div className="mb-6 grid grid-cols-3 gap-2 rounded bg-stone-100 p-4 font-mono text-sm">
                            {words.map((word, i) => (
                                <div
                                    key={word + String(i)}
                                    className="flex gap-1"
                                >
                                    <span className="text-stone-400">
                                        {i + 1}.
                                    </span>
                                    <span>{word}</span>
                                </div>
                            ))}
                        </div>
                        <button
                            type="button"
                            onClick={() => setStep('confirm')}
                            className="w-full rounded bg-stone-800 px-4 py-2 text-white"
                        >
                            I've saved my recovery phrase
                        </button>
                    </div>
                )}

                {step === 'confirm' && (
                    <div>
                        <p className="mb-4 text-stone-600">
                            Verify your recovery phrase. Enter the requested
                            words.
                        </p>
                        <div className="mb-4">
                            <label
                                htmlFor="confirm-word-1"
                                className="mb-1 block text-sm text-stone-500"
                            >
                                Word #{checkIndices[0] + 1}
                            </label>
                            <input
                                id="confirm-word-1"
                                type="text"
                                value={input1}
                                onChange={(e) => setInput1(e.target.value)}
                                className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-sm"
                                autoComplete="off"
                            />
                        </div>
                        <div className="mb-4">
                            <label
                                htmlFor="confirm-word-2"
                                className="mb-1 block text-sm text-stone-500"
                            >
                                Word #{checkIndices[1] + 1}
                            </label>
                            <input
                                id="confirm-word-2"
                                type="text"
                                value={input2}
                                onChange={(e) => setInput2(e.target.value)}
                                className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-sm"
                                autoComplete="off"
                            />
                        </div>
                        {error && (
                            <p className="mb-4 text-sm text-red-600">{error}</p>
                        )}
                        <button
                            type="button"
                            onClick={handleConfirm}
                            className="w-full rounded bg-stone-800 px-4 py-2 text-white"
                        >
                            Confirm & Register
                        </button>
                        <button
                            type="button"
                            onClick={() => setStep('generate')}
                            className="mt-2 w-full rounded px-4 py-2 text-sm text-stone-500"
                        >
                            Go back
                        </button>
                    </div>
                )}

                {step === 'registering' && (
                    <p className="text-stone-500">Registering...</p>
                )}

                {step === 'done' && completedSession && (
                    <div>
                        <p className="mb-2 text-stone-600">
                            You're registered! Your invite handle:
                        </p>
                        <p className="mb-6 rounded bg-stone-100 p-4 text-center font-mono text-lg">
                            {completedSession.inviteHandle}
                        </p>
                        <p className="mb-6 text-sm text-stone-500">
                            Share this handle with others so they can message
                            you.
                        </p>
                        <button
                            type="button"
                            onClick={() => onComplete(completedSession)}
                            className="w-full rounded bg-stone-800 px-4 py-2 text-white"
                        >
                            Start chatting
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}

function detectDeviceLabel(): string {
    const ua = navigator.userAgent;
    if (/iPhone/.test(ua)) return 'iPhone';
    if (/iPad/.test(ua)) return 'iPad';
    if (/Android/.test(ua)) return 'Android';
    if (/Mac/.test(ua)) return 'Mac';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Linux/.test(ua)) return 'Linux';
    return 'Browser';
}
