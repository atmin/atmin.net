import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { register } from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { base64UrlEncode, deriveKeys, generateBackupSecret } from '@/crypto';
import { type Session, saveSession } from '@/session';

type Step = 'generate' | 'registering' | 'done';

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

export default function Register() {
    const navigate = useNavigate();
    const [step, setStep] = useState<Step>('generate');
    const [mnemonic, setMnemonic] = useState('');
    const [copied, setCopied] = useState(false);
    const [understood, setUnderstood] = useState(false);
    const [stored, setStored] = useState(false);
    const [error, setError] = useState('');

    // Generate mnemonic on first render
    if (!mnemonic) {
        const secret = generateBackupSecret();
        const m = entropyToMnemonic(secret, wordlist);
        setMnemonic(m);
    }

    const handleCopy = () => {
        navigator.clipboard.writeText(mnemonic);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

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
                backupKey: keys.backupKey,
            };

            await saveSession(session);
            setStep('done');

            // Redirect to home after short delay
            setTimeout(() => navigate('/'), 1000);
        } catch (e) {
            setError(`Registration failed: ${e}`);
            setStep('generate');
        }
    };

    return (
        <div className="flex min-h-screen items-center justify-center bg-stone-50 p-8">
            <div className="w-full max-w-md">
                <h1 className="mb-8 text-2xl font-bold">
                    <a href="/" className="hover:text-stone-600">
                        atmin
                    </a>
                </h1>

                {step === 'generate' && (
                    <>
                        <Card className="mb-6">
                            <CardHeader>
                                <CardTitle>Your Recovery Phrase</CardTitle>
                                <CardDescription>
                                    Write down these 12 words in order. This is
                                    the only way to recover your account.
                                </CardDescription>
                            </CardHeader>
                            <CardContent>
                                <div className="mb-4 rounded border border-stone-200 bg-stone-50 p-4 font-mono text-sm">
                                    {mnemonic}
                                </div>
                                <Button
                                    onClick={handleCopy}
                                    variant="outline"
                                    className="w-full"
                                >
                                    {copied ? 'Copied!' : 'Copy to Clipboard'}
                                </Button>
                            </CardContent>
                        </Card>

                        <Alert className="mb-6">
                            <AlertTitle>⚠️ Critical Security Warning</AlertTitle>
                            <AlertDescription className="space-y-2 text-sm">
                                <p>
                                    Anyone with these words can access your
                                    account and read all your messages.
                                </p>
                                <p>
                                    Store them securely in a password manager
                                    like{' '}
                                    <a
                                        href="https://en.wikipedia.org/wiki/List_of_password_managers"
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        className="underline"
                                    >
                                        1Password, Bitwarden, or KeePass
                                    </a>
                                    .
                                </p>
                                <p className="font-semibold">
                                    If you lose these words, your account and
                                    message history cannot be recovered.
                                </p>
                            </AlertDescription>
                        </Alert>

                        <div className="mb-6 space-y-3">
                            {/* biome-ignore lint/a11y/noLabelWithoutControl: Radix UI Checkbox handles accessibility */}
                            <label className="flex items-start gap-3">
                                <Checkbox
                                    checked={understood}
                                    onCheckedChange={(checked) =>
                                        setUnderstood(checked === true)
                                    }
                                />
                                <span className="text-sm">
                                    I understand that these words are the only
                                    way to recover my account
                                </span>
                            </label>

                            {/* biome-ignore lint/a11y/noLabelWithoutControl: Radix UI Checkbox handles accessibility */}
                            <label className="flex items-start gap-3">
                                <Checkbox
                                    checked={stored}
                                    onCheckedChange={(checked) =>
                                        setStored(checked === true)
                                    }
                                />
                                <span className="text-sm">
                                    I have stored these words in a safe place
                                </span>
                            </label>
                        </div>

                        {error && (
                            <p className="mb-4 text-sm text-red-600">{error}</p>
                        )}

                        <Button
                            onClick={handleRegister}
                            disabled={!understood || !stored}
                            className="w-full"
                        >
                            Register
                        </Button>
                    </>
                )}

                {step === 'registering' && (
                    <Card>
                        <CardContent className="pt-6">
                            <p className="text-center text-stone-500">
                                Creating your account...
                            </p>
                        </CardContent>
                    </Card>
                )}

                {step === 'done' && (
                    <Card>
                        <CardContent className="pt-6">
                            <p className="mb-2 text-center text-green-600">
                                ✓ Account created successfully
                            </p>
                            <p className="text-center text-sm text-stone-500">
                                Redirecting...
                            </p>
                        </CardContent>
                    </Card>
                )}
            </div>
        </div>
    );
}
