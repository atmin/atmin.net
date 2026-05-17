// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    listDevices: vi.fn(),
    revokeDevice: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/crypto', () => ({
    base64UrlEncode: vi.fn().mockReturnValue('sig-encoded'),
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
    signAuthProof: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
}));

vi.mock('@scure/bip39', () => ({
    mnemonicToEntropy: vi.fn().mockReturnValue(new Uint8Array(16)),
}));

vi.mock('@scure/bip39/wordlists/english.js', () => ({ wordlist: [] }));

const fakeDevices = [
    { device_id: 'dev1', device_label: 'iPhone', created_at: '2024-01-01' },
    { device_id: 'dev2', device_label: 'Chrome', created_at: '2024-01-02' },
];

describe('useDevices', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('fetches devices on mount via listDevices', async () => {
        const { listDevices } = await import('@/lib/api');
        vi.mocked(listDevices).mockResolvedValue(fakeDevices);

        const { useDevices } = await import('./useDevices');
        const { result } = renderHook(() => useDevices('tok', 'user1'));

        expect(result.current.loading).toBe(true);

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(listDevices).toHaveBeenCalledWith('tok', 'user1');
        expect(result.current.devices).toEqual(fakeDevices);
        expect(result.current.loading).toBe(false);
    });

    it('handleRevoke with valid mnemonic calls revokeDevice and refreshes', async () => {
        const { listDevices, revokeDevice } = await import('@/lib/api');
        vi.mocked(listDevices).mockResolvedValue(fakeDevices);

        const { useDevices } = await import('./useDevices');
        const { result } = renderHook(() => useDevices('tok', 'user1'));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        act(() => {
            result.current.setMnemonicInput(
                'word1 word2 word3 word4 word5 word6 word7 word8 word9 word10 word11 word12',
            );
        });

        await act(async () => {
            await result.current.handleRevoke('dev1');
        });

        expect(revokeDevice).toHaveBeenCalledWith(
            'tok',
            expect.objectContaining({ device_id: 'dev1' }),
        );
        // refreshes: listDevices called a second time
        expect(listDevices).toHaveBeenCalledTimes(2);
        expect(result.current.revokeError).toBeNull();
    });

    it('handleRevoke with bad mnemonic sets revokeError and does not call revokeDevice', async () => {
        const { listDevices, revokeDevice } = await import('@/lib/api');
        vi.mocked(listDevices).mockResolvedValue(fakeDevices);

        const bip39 = await import('@scure/bip39');
        vi.mocked(bip39.mnemonicToEntropy).mockImplementationOnce(() => {
            throw new Error('Invalid mnemonic');
        });

        const { useDevices } = await import('./useDevices');
        const { result } = renderHook(() => useDevices('tok', 'user1'));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        act(() => {
            result.current.setMnemonicInput('bad mnemonic here');
        });

        await act(async () => {
            await result.current.handleRevoke('dev1');
        });

        expect(revokeDevice).not.toHaveBeenCalled();
        expect(result.current.revokeError).toBe('Invalid mnemonic');
    });
});
