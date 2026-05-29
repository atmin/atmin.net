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
                key_version: 1,
            }),
        ),
    ),
}));

vi.mock('@/lib/credential', () => ({
    deriveSecretFromPassword: vi
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
    signAuthProofV2: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
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

    it('password revoke reads profile params, derives, and emits a v2 auth proof', async () => {
        const { listDevices, revokeDevice, storeGet } = await import(
            '@/lib/api'
        );
        const { deriveSecretFromPassword } = await import('@/lib/credential');
        const { signAuthProofV2 } = await import('@/lib/crypto');
        vi.mocked(listDevices).mockResolvedValue(fakeDevices);

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

        // Read the caller's own profile.json for salt/kdf + key_version.
        expect(storeGet).toHaveBeenCalledWith(
            'tok',
            'users/user1/profile.json',
        );
        expect(deriveSecretFromPassword).toHaveBeenCalledWith(
            'my-strong-password',
            { salt: 'c2FsdA', kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 } },
        );
        // The auth proof carries the account's current key_version.
        const proofPayload = vi.mocked(signAuthProofV2).mock.calls[0][1];
        expect(proofPayload.key_version).toBe(1);
        expect(revokeDevice).toHaveBeenCalledWith(
            'tok',
            expect.objectContaining({ device_id: 'dev1' }),
        );
        expect(listDevices).toHaveBeenCalledTimes(2);
        expect(result.current.revokeError).toBeNull();
    });

    it('surfaces a revokeError and does not call revokeDevice when derivation fails', async () => {
        const { listDevices, revokeDevice } = await import('@/lib/api');
        const { deriveSecretFromPassword } = await import('@/lib/credential');
        vi.mocked(listDevices).mockResolvedValue(fakeDevices);
        vi.mocked(deriveSecretFromPassword).mockRejectedValueOnce(
            new Error('Account is missing credential parameters.'),
        );

        const { useDevices } = await import('./useDevices');
        const { result } = renderHook(() => useDevices('tok', 'user1'));
        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        act(() => {
            result.current.setSecretInput('some-password');
        });
        await act(async () => {
            await result.current.handleRevoke('dev1');
        });

        expect(revokeDevice).not.toHaveBeenCalled();
        expect(result.current.revokeError).toContain(
            'missing credential parameters',
        );
    });
});
