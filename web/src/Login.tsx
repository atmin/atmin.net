import { mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ulid } from 'ulid';
import { addDevice, resolve } from '@/api';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { base64UrlEncode, deriveKeys, signAuthProof } from '@/crypto';
import { type Session, saveSession } from '@/session';

interface Props {
    onSuccess: (session: Session) => void;
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

export default function Login({ onSuccess }: Props) {
    const navigate = useNavigate();
    const [inviteHandle, setInviteHandle] = useState('');
    const [mnemonic, setMnemonic] = useState('');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
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

    return (
        <div className="flex min-h-screen items-center justify-center bg-stone-50 p-8">
            <div className="w-full max-w-md">
                <h1 className="mb-8 text-2xl font-bold">
                    <a href="/" className="hover:text-stone-600">
                        atmin
                    </a>
                </h1>

                <Card>
                    <CardHeader>
                        <CardTitle>Sign In</CardTitle>
                        <CardDescription>
                            Restore your account using your recovery phrase
                        </CardDescription>
                    </CardHeader>
                    <CardContent>
                        <form onSubmit={handleLogin} className="space-y-4">
                            <div>
                                <label
                                    htmlFor="invite-handle"
                                    className="mb-1 block text-sm font-medium"
                                >
                                    Invite Handle
                                </label>
                                <input
                                    id="invite-handle"
                                    type="text"
                                    value={inviteHandle}
                                    onChange={(e) =>
                                        setInviteHandle(e.target.value)
                                    }
                                    placeholder="copper-falcon"
                                    required
                                    className="w-full rounded border border-stone-300 px-3 py-2 text-sm"
                                />
                            </div>

                            <div>
                                <label
                                    htmlFor="mnemonic"
                                    className="mb-1 block text-sm font-medium"
                                >
                                    Recovery Phrase
                                </label>
                                <textarea
                                    id="mnemonic"
                                    value={mnemonic}
                                    onChange={(e) =>
                                        setMnemonic(e.target.value)
                                    }
                                    placeholder="word1 word2 word3 ... word12"
                                    required
                                    rows={3}
                                    className="w-full rounded border border-stone-300 px-3 py-2 font-mono text-sm"
                                />
                                <p className="mt-1 text-xs text-stone-500">
                                    Enter your 12-word recovery phrase
                                </p>
                            </div>

                            {error && (
                                <Alert variant="destructive">
                                    <AlertTitle>Login Failed</AlertTitle>
                                    <AlertDescription>{error}</AlertDescription>
                                </Alert>
                            )}

                            <Button
                                type="submit"
                                disabled={loading || !inviteHandle || !mnemonic}
                                className="w-full"
                            >
                                {loading ? 'Signing in...' : 'Sign In'}
                            </Button>
                        </form>
                    </CardContent>
                </Card>

                <p className="mt-4 text-center text-sm text-stone-500">
                    Don't have an account?{' '}
                    <a href="/register" className="underline">
                        Create one
                    </a>
                </p>
            </div>
        </div>
    );
}
