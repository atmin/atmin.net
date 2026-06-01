// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/auth';

vi.mock('@/lib/api', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    return {
        ...actual,
        deleteProfile: vi.fn().mockResolvedValue(undefined),
        storeGet: vi.fn(
            async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        auth_public_key: 'AUTH_PUB',
                        salt: 'c2FsdA',
                        kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 },
                    }),
                ).buffer,
        ),
    };
});

vi.mock('@/lib/credential', () => ({
    deriveSecretFromPassword: vi.fn(async () => new Uint8Array(16).fill(5)),
}));

vi.mock('@/lib/crypto', () => ({
    base64UrlEncode: vi.fn((bytes: Uint8Array) => {
        if (bytes.length === 1 && bytes[0] === 0xaa) return 'AUTH_PUB';
        return 'WRONG_PUB';
    }),
    deriveKeys: vi.fn().mockResolvedValue({
        auth: {
            privateKey: {} as CryptoKey,
            publicKey: {} as CryptoKey,
            publicKeyBytes: new Uint8Array([0xaa]),
        },
        sharing: {
            privateKey: {} as CryptoKey,
            publicKey: {} as CryptoKey,
            publicKeyBytes: new Uint8Array([2]),
        },
        backupKey: {} as CryptoKey,
    }),
}));

vi.mock('react-router-dom', () => ({
    useNavigate: vi.fn(),
}));

const baseSession: Session = {
    token: 'TOK',
    userId: 'U_ALICE',
    deviceId: 'D1',
    handle: 'alice',
    sharingPrivateKey: {} as CryptoKey,
    sharingPublicKeyBytes: new Uint8Array(),
    backupKey: {} as CryptoKey,
    keyVersion: 1,
};

async function loadHook() {
    const navigate = vi.fn();
    const { useNavigate } = await import('react-router-dom');
    vi.mocked(useNavigate).mockReturnValue(navigate);
    const { useDeleteAccount } = await import('./useDeleteAccount');
    return { useDeleteAccount, navigate };
}

describe('useDeleteAccount', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('happy path: verifies, deletes, tears down + navigates to Landing', async () => {
        const { useDeleteAccount, navigate } = await loadHook();
        const { deleteProfile } = await import('@/lib/api');
        const onDeleted = vi.fn().mockResolvedValue(undefined);

        const { result } = renderHook(() =>
            useDeleteAccount(baseSession, onDeleted),
        );
        act(() => {
            result.current.setPassword('correct-pw');
            result.current.setHandleConfirm('alice');
            result.current.setAcknowledged(true);
        });
        await act(async () => {
            await result.current.submit();
        });

        expect(deleteProfile).toHaveBeenCalledWith('TOK');
        expect(onDeleted).toHaveBeenCalledOnce();
        expect(navigate).toHaveBeenCalledWith('/', { replace: true });
        expect(result.current.error).toBeNull();
    });

    it('wrong password: error surfaces, no delete, no teardown', async () => {
        const { useDeleteAccount, navigate } = await loadHook();
        const { deleteProfile } = await import('@/lib/api');
        const { deriveKeys } = await import('@/lib/crypto');
        const onDeleted = vi.fn();

        // Derived pubkey won't match the profile's AUTH_PUB.
        vi.mocked(deriveKeys).mockResolvedValueOnce({
            auth: {
                privateKey: {} as CryptoKey,
                publicKey: {} as CryptoKey,
                publicKeyBytes: new Uint8Array([0xbb]),
            },
            sharing: {
                privateKey: {} as CryptoKey,
                publicKey: {} as CryptoKey,
                publicKeyBytes: new Uint8Array([2]),
            },
            backupKey: {} as CryptoKey,
        });

        const { result } = renderHook(() =>
            useDeleteAccount(baseSession, onDeleted),
        );
        act(() => {
            result.current.setPassword('wrong-pw');
            result.current.setHandleConfirm('alice');
            result.current.setAcknowledged(true);
        });
        await act(async () => {
            await result.current.submit();
        });

        expect(result.current.error).toMatch(/incorrect/);
        expect(result.current.step).toBe('enter');
        expect(deleteProfile).not.toHaveBeenCalled();
        expect(onDeleted).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('5xx during delete: error surfaces, session NOT torn down', async () => {
        const { useDeleteAccount, navigate } = await loadHook();
        const { deleteProfile, APIError } = await import('@/lib/api');
        const onDeleted = vi.fn();

        vi.mocked(deleteProfile).mockRejectedValueOnce(
            new APIError(500, 'internal', 'boom'),
        );

        const { result } = renderHook(() =>
            useDeleteAccount(baseSession, onDeleted),
        );
        act(() => {
            result.current.setPassword('correct-pw');
            result.current.setHandleConfirm('alice');
            result.current.setAcknowledged(true);
        });
        await act(async () => {
            await result.current.submit();
        });

        expect(result.current.error).toMatch(/Could not delete/);
        expect(result.current.step).toBe('enter');
        expect(onDeleted).not.toHaveBeenCalled();
        expect(navigate).not.toHaveBeenCalled();
    });

    it('401 during delete (lost the race): tears down + navigates anyway', async () => {
        const { useDeleteAccount, navigate } = await loadHook();
        const { deleteProfile, APIError } = await import('@/lib/api');
        const onDeleted = vi.fn().mockResolvedValue(undefined);

        vi.mocked(deleteProfile).mockRejectedValueOnce(
            new APIError(401, 'unauthorized', 'gone'),
        );

        const { result } = renderHook(() =>
            useDeleteAccount(baseSession, onDeleted),
        );
        act(() => {
            result.current.setPassword('correct-pw');
            result.current.setHandleConfirm('alice');
            result.current.setAcknowledged(true);
        });
        await act(async () => {
            await result.current.submit();
        });

        expect(onDeleted).toHaveBeenCalledOnce();
        expect(navigate).toHaveBeenCalledWith('/', { replace: true });
        expect(result.current.error).toBeNull();
    });
});
