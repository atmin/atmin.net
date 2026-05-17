// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    addDevice: vi.fn(),
    resolve: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    saveSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/crypto', () => ({
    base64UrlEncode: vi.fn().mockReturnValue('encoded'),
    deriveKeys: vi.fn().mockResolvedValue({
        auth: {
            privateKey: {} as CryptoKey,
            publicKeyBytes: new Uint8Array([1]),
        },
        sharing: {
            privateKey: {} as CryptoKey,
            publicKeyBytes: new Uint8Array([2]),
        },
        backupKey: {} as CryptoKey,
    }),
    signAuthProof: vi.fn().mockResolvedValue(new Uint8Array([9, 8, 7])),
}));

vi.mock('@/lib/utils', () => ({
    detectDeviceLabel: vi.fn().mockReturnValue('test-device'),
}));

vi.mock('react-router-dom', () => ({
    useNavigate: vi.fn(),
}));

vi.mock('@scure/bip39', () => ({
    mnemonicToEntropy: vi.fn().mockReturnValue(new Uint8Array(16)),
}));

vi.mock('@scure/bip39/wordlists/english.js', () => ({ wordlist: [] }));

describe('useLogin', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('happy path: resolves handle, derives keys, adds device, saves session, navigates to /', async () => {
        const { resolve, addDevice } = await import('@/lib/api');
        const { saveSession } = await import('@/lib/auth');
        const { useNavigate } = await import('react-router-dom');
        const navigate = vi.fn();
        vi.mocked(useNavigate).mockReturnValue(navigate);
        vi.mocked(resolve).mockResolvedValue({
            user_id: 'user-resolved',
            sharing_public_key: 'pubkey-b64',
        });
        vi.mocked(addDevice).mockResolvedValue({
            device_id: 'new-device',
            token: 'new-token',
        });

        const onSuccess = vi.fn();
        const { useLogin } = await import('./useLogin');
        const { result } = renderHook(() => useLogin(onSuccess));

        await act(async () => {
            await result.current.handleLogin('alice', 'word1 word2 word3');
        });

        expect(resolve).toHaveBeenCalledWith('alice');
        expect(addDevice).toHaveBeenCalled();
        expect(saveSession).toHaveBeenCalled();
        expect(onSuccess).toHaveBeenCalled();
        expect(navigate).toHaveBeenCalledWith('/');
        expect(result.current.error).toBe('');
    });

    it('addDevice failure: sets error, loading stays false', async () => {
        const { resolve, addDevice } = await import('@/lib/api');
        const { useNavigate } = await import('react-router-dom');
        vi.mocked(useNavigate).mockReturnValue(vi.fn());
        vi.mocked(resolve).mockResolvedValue({
            user_id: 'user-resolved',
            sharing_public_key: 'pubkey-b64',
        });
        vi.mocked(addDevice).mockRejectedValue(
            new Error('Device limit reached'),
        );

        const onSuccess = vi.fn();
        const { useLogin } = await import('./useLogin');
        const { result } = renderHook(() => useLogin(onSuccess));

        await act(async () => {
            await result.current.handleLogin('alice', 'word1 word2 word3');
        });

        expect(result.current.error).toBe('Device limit reached');
        expect(result.current.loading).toBe(false);
        expect(onSuccess).not.toHaveBeenCalled();
    });
});
