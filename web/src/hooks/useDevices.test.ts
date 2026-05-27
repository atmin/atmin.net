// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    listDevices: vi.fn(),
    revokeDevice: vi.fn().mockResolvedValue(undefined),
    storeGet: vi.fn().mockResolvedValue(
        new TextEncoder().encode(
            JSON.stringify({
                salt: 'c2FsdA',
                kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 },
            }),
        ),
    ),
}));

vi.mock('@/lib/credential', () => ({
    isLegacyMnemonic: vi.fn().mockReturnValue(false),
    deriveSecretFromCredential: vi
        .fn()
        .mockResolvedValue(new Uint8Array(16).fill(5)),
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

    it('v2 password revoke reads profile params, derives, and revokes', async () => {
        const { listDevices, revokeDevice, storeGet } = await import(
            '@/lib/api'
        );
        const { deriveSecretFromCredential, isLegacyMnemonic } = await import(
            '@/lib/credential'
        );
        vi.mocked(listDevices).mockResolvedValue(fakeDevices);
        vi.mocked(isLegacyMnemonic).mockReturnValue(false);

        const { useDevices } = await import('./useDevices');
        const { result } = renderHook(() => useDevices('tok', 'user1'));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        act(() => {
            result.current.setSecretInput('my-strong-password');
        });

        await act(async () => {
            await result.current.handleRevoke('dev1');
        });

        // v2 path read the caller's own profile.json for salt/kdf
        expect(storeGet).toHaveBeenCalledWith(
            'tok',
            'users/user1/profile.json',
        );
        expect(deriveSecretFromCredential).toHaveBeenCalledWith(
            'my-strong-password',
            { salt: 'c2FsdA', kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 } },
        );
        expect(revokeDevice).toHaveBeenCalledWith(
            'tok',
            expect.objectContaining({ device_id: 'dev1' }),
        );
        expect(listDevices).toHaveBeenCalledTimes(2);
        expect(result.current.revokeError).toBeNull();
    });

    it('legacy mnemonic revoke skips the profile read', async () => {
        const { listDevices, storeGet } = await import('@/lib/api');
        const { isLegacyMnemonic } = await import('@/lib/credential');
        vi.mocked(listDevices).mockResolvedValue(fakeDevices);
        vi.mocked(isLegacyMnemonic).mockReturnValue(true);

        const { useDevices } = await import('./useDevices');
        const { result } = renderHook(() => useDevices('tok', 'user1'));
        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        act(() => {
            result.current.setSecretInput('twelve word mnemonic here');
        });
        await act(async () => {
            await result.current.handleRevoke('dev1');
        });

        expect(storeGet).not.toHaveBeenCalled();
    });

    it('surfaces a revokeError and does not call revokeDevice when derivation fails', async () => {
        const { listDevices, revokeDevice } = await import('@/lib/api');
        const { deriveSecretFromCredential } = await import('@/lib/credential');
        vi.mocked(listDevices).mockResolvedValue(fakeDevices);
        vi.mocked(deriveSecretFromCredential).mockRejectedValueOnce(
            new Error('Recovery phrase required for legacy account.'),
        );

        const { useDevices } = await import('./useDevices');
        const { result } = renderHook(() => useDevices('tok', 'user1'));
        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        act(() => {
            result.current.setSecretInput('not-a-mnemonic');
        });
        await act(async () => {
            await result.current.handleRevoke('dev1');
        });

        expect(revokeDevice).not.toHaveBeenCalled();
        expect(result.current.revokeError).toContain(
            'Recovery phrase required',
        );
    });
});
