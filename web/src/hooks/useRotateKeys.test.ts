// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/auth';

// Captured call order so we can assert chain-write-before-rotate.
const callOrder: string[] = [];

vi.mock('@/lib/api', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    return {
        ...actual,
        rotateKeys: vi.fn(async (...args) => {
            callOrder.push('rotateKeys');
            void args;
            return { token: 'NEW_TOKEN', key_version: 2 };
        }),
        storeGet: vi.fn(
            async () =>
                new TextEncoder().encode(
                    JSON.stringify({
                        auth_public_key: 'OLD_AUTH_PUB',
                        salt: 'c2FsdA',
                        kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 },
                        key_version: 1,
                    }),
                ).buffer,
        ),
    };
});

vi.mock('@/lib/argon2-worker.client', () => ({
    argonStretch: vi.fn().mockResolvedValue(new Uint8Array(16).fill(5)),
}));

vi.mock('@/lib/auth', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/auth')>('@/lib/auth');
    return {
        ...actual,
        saveSession: vi.fn().mockResolvedValue(undefined),
        clearSession: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('@/lib/crypto', () => ({
    base64UrlEncode: vi.fn((bytes: Uint8Array) => {
        if (bytes.length === 1 && bytes[0] === 0xaa) return 'OLD_AUTH_PUB';
        if (bytes.length === 1 && bytes[0] === 0xbb)
            return 'WRONG_OLD_AUTH_PUB';
        return 'encoded';
    }),
    base64UrlDecode: vi.fn(() => new Uint8Array(16)),
    DEFAULT_KDF: { type: 'argon2id', m: 65536, t: 3, p: 1 },
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
    generateSalt: vi.fn().mockReturnValue(new Uint8Array(16)),
    signContinuity: vi.fn().mockResolvedValue(new Uint8Array(64)),
}));

vi.mock('@/lib/key-chain', () => ({
    buildChainLink: vi.fn(async () => {
        callOrder.push('buildChainLink');
        return { from: 1, to: 2, iv: 'a', ciphertext: 'b' };
    }),
    appendChainLink: vi.fn(async () => {
        callOrder.push('appendChainLink');
    }),
}));

vi.mock('@/lib/credential', () => ({
    deriveSecretFromPassword: vi.fn(async () => new Uint8Array(16).fill(5)),
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
    const { useRotateKeys } = await import('./useRotateKeys');
    return { useRotateKeys, navigate };
}

describe('useRotateKeys', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        callOrder.length = 0;
    });

    it('happy path: derives → builds chain → rotates → swaps session', async () => {
        const { useRotateKeys } = await loadHook();
        const { rotateKeys } = await import('@/lib/api');
        const { saveSession } = await import('@/lib/auth');
        const { appendChainLink } = await import('@/lib/key-chain');

        const onSuccess = vi.fn();
        const { result } = renderHook(() =>
            useRotateKeys(baseSession, onSuccess),
        );

        act(() => {
            result.current.setCurrent('old-pw');
            result.current.setNew('new-pw-strong');
            result.current.setConfirm('new-pw-strong');
            result.current.setAcknowledged(true);
        });
        await act(async () => {
            await result.current.submit();
        });

        // Chain write MUST happen before the rotate call.
        const chainIdx = callOrder.indexOf('appendChainLink');
        const rotateIdx = callOrder.indexOf('rotateKeys');
        expect(chainIdx).toBeGreaterThanOrEqual(0);
        expect(rotateIdx).toBeGreaterThan(chainIdx);

        expect(appendChainLink).toHaveBeenCalledOnce();
        expect(rotateKeys).toHaveBeenCalledOnce();

        const rotated = vi.mocked(saveSession).mock.calls[0][0];
        expect(rotated.token).toBe('NEW_TOKEN');
        expect(rotated.keyVersion).toBe(2);
        expect(onSuccess).toHaveBeenCalledWith(rotated);
    });

    it('wrong current password: derived pubkey ≠ profile.auth_public_key; no API calls', async () => {
        const { useRotateKeys } = await loadHook();
        const { deriveKeys } = await import('@/lib/crypto');
        const { rotateKeys } = await import('@/lib/api');
        const { appendChainLink } = await import('@/lib/key-chain');

        // Make the derived auth pubkey NOT match what readOwnProfile returns.
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

        const onSuccess = vi.fn();
        const { result } = renderHook(() =>
            useRotateKeys(baseSession, onSuccess),
        );
        act(() => {
            result.current.setCurrent('wrong-old');
            result.current.setNew('new-pw');
            result.current.setConfirm('new-pw');
            result.current.setAcknowledged(true);
        });
        await act(async () => {
            await result.current.submit();
        });

        expect(result.current.error).toMatch(/is incorrect/);
        expect(result.current.step).toBe('enter');
        expect(rotateKeys).not.toHaveBeenCalled();
        expect(appendChainLink).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
    });

    it('409 key_version_stale: clears session and navigates to /login', async () => {
        const { useRotateKeys, navigate } = await loadHook();
        const { rotateKeys, KeyVersionStaleError } = await import('@/lib/api');
        const { clearSession } = await import('@/lib/auth');

        vi.mocked(rotateKeys).mockRejectedValueOnce(
            new KeyVersionStaleError(3),
        );

        const onSuccess = vi.fn();
        const { result } = renderHook(() =>
            useRotateKeys(baseSession, onSuccess),
        );
        act(() => {
            result.current.setCurrent('old');
            result.current.setNew('new');
            result.current.setConfirm('new');
            result.current.setAcknowledged(true);
        });
        await act(async () => {
            await result.current.submit();
        });

        expect(clearSession).toHaveBeenCalledOnce();
        expect(navigate).toHaveBeenCalledWith('/login');
        expect(onSuccess).not.toHaveBeenCalled();
    });

    it('403 bad_continuity: surfaces error, does NOT clear local session', async () => {
        const { useRotateKeys } = await loadHook();
        const { rotateKeys, APIError } = await import('@/lib/api');
        const { clearSession } = await import('@/lib/auth');

        vi.mocked(rotateKeys).mockRejectedValueOnce(
            new APIError(403, 'bad_continuity', 'sig fail'),
        );

        const onSuccess = vi.fn();
        const { result } = renderHook(() =>
            useRotateKeys(baseSession, onSuccess),
        );
        act(() => {
            result.current.setCurrent('old');
            result.current.setNew('new');
            result.current.setConfirm('new');
            result.current.setAcknowledged(true);
        });
        await act(async () => {
            await result.current.submit();
        });

        expect(result.current.error).toContain('bad_continuity');
        expect(result.current.step).toBe('enter');
        expect(clearSession).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
    });

    it('chain-write failure: rotateKeys is NOT called', async () => {
        const { useRotateKeys } = await loadHook();
        const { rotateKeys } = await import('@/lib/api');
        const { appendChainLink } = await import('@/lib/key-chain');

        vi.mocked(appendChainLink).mockRejectedValueOnce(
            new Error('chain write timeout'),
        );

        const onSuccess = vi.fn();
        const { result } = renderHook(() =>
            useRotateKeys(baseSession, onSuccess),
        );
        act(() => {
            result.current.setCurrent('old');
            result.current.setNew('new');
            result.current.setConfirm('new');
            result.current.setAcknowledged(true);
        });
        await act(async () => {
            await result.current.submit();
        });

        expect(result.current.error).toContain('chain write timeout');
        expect(rotateKeys).not.toHaveBeenCalled();
        expect(onSuccess).not.toHaveBeenCalled();
    });
});
