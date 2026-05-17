// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    register: vi.fn(),
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
    generateBackupSecret: vi.fn().mockReturnValue(new Uint8Array(16)),
}));

vi.mock('@/lib/utils', () => ({
    detectDeviceLabel: vi.fn().mockReturnValue('test-device'),
}));

vi.mock('@scure/bip39', () => ({
    entropyToMnemonic: vi
        .fn()
        .mockReturnValue(
            'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
        ),
    mnemonicToEntropy: vi.fn().mockReturnValue(new Uint8Array(16)),
}));

vi.mock('@scure/bip39/wordlists/english.js', () => ({ wordlist: [] }));

describe('useRegister', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('generates a 12-word mnemonic on first render and does not regenerate on re-render', async () => {
        const { generateBackupSecret } = await import('@/lib/crypto');
        const { entropyToMnemonic } = await import('@scure/bip39');

        const { useRegister } = await import('./useRegister');
        const onSuccess = vi.fn();
        const { result, rerender } = renderHook(() => useRegister(onSuccess));

        expect(generateBackupSecret).toHaveBeenCalledOnce();
        expect(result.current.mnemonic).toBe(
            'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
        );

        // Re-render should not regenerate
        rerender();
        expect(generateBackupSecret).toHaveBeenCalledOnce();
        expect(entropyToMnemonic).toHaveBeenCalledOnce();
    });

    it('handleRegister calls register, saves session, calls onSuccess, advances step to done', async () => {
        const { register } = await import('@/lib/api');
        const { saveSession } = await import('@/lib/auth');
        vi.mocked(register).mockResolvedValue({
            user_id: 'new-user',
            device_id: 'new-dev',
            token: 'new-tok',
            handle: 'bob',
        });

        const onSuccess = vi.fn();
        const { useRegister } = await import('./useRegister');
        const { result } = renderHook(() => useRegister(onSuccess));

        expect(result.current.step).toBe('generate');

        await act(async () => {
            await result.current.handleRegister();
        });

        expect(register).toHaveBeenCalled();
        expect(saveSession).toHaveBeenCalled();
        expect(onSuccess).toHaveBeenCalled();
        expect(result.current.step).toBe('done');
    });
});
