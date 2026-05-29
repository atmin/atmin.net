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

vi.mock('@/lib/credential', () => ({
    deriveSecretFromPassword: vi
        .fn()
        .mockResolvedValue(new Uint8Array(16).fill(5)),
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
    signAuthProofV2: vi.fn().mockResolvedValue(new Uint8Array([2, 2, 2])),
}));

vi.mock('@/lib/utils', () => ({
    detectDeviceLabel: vi.fn().mockReturnValue('test-device'),
}));

vi.mock('react-router-dom', () => ({
    useNavigate: vi.fn(),
}));

describe('useLogin', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    async function runLogin(secret: string) {
        const { resolve, addDevice } = await import('@/lib/api');
        const { useNavigate } = await import('react-router-dom');
        vi.mocked(useNavigate).mockReturnValue(vi.fn());
        vi.mocked(addDevice).mockResolvedValue({
            device_id: 'new-device',
            token: 'new-token',
        });

        const { useLogin } = await import('./useLogin');
        const onSuccess = vi.fn();
        const { result } = renderHook(() => useLogin(onSuccess));
        await act(async () => {
            await result.current.handleLogin('alice', secret);
        });
        return { result, resolve, onSuccess };
    }

    it('password login at key_version 1 derives and emits a v2 auth proof carrying kv=1', async () => {
        const { resolve, addDevice } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({
            status: 'live',
            user_id: 'user-resolved',
            sharing_public_key: 'pk',
            salt: 'c2FsdA',
            kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 },
            key_version: 1,
        });
        const { deriveSecretFromPassword } = await import('@/lib/credential');
        const { signAuthProofV2 } = await import('@/lib/crypto');

        const { onSuccess } = await runLogin('my-strong-password');

        expect(deriveSecretFromPassword).toHaveBeenCalledWith(
            'my-strong-password',
            { salt: 'c2FsdA', kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 } },
        );
        expect(signAuthProofV2).toHaveBeenCalled();
        const v2Payload = vi.mocked(signAuthProofV2).mock.calls[0][1];
        expect(v2Payload.key_version).toBe(1);
        const sentProof = vi.mocked(addDevice).mock.calls[0][0].auth_proof;
        expect(sentProof.payload.key_version).toBe(1);
        expect(onSuccess).toHaveBeenCalled();
    });

    it('password login at key_version > 1 emits a v2 auth proof carrying the current kv', async () => {
        const { resolve, addDevice } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({
            status: 'live',
            user_id: 'user-resolved',
            sharing_public_key: 'pk',
            salt: 'c2FsdA',
            kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 },
            key_version: 3,
        });
        const { signAuthProofV2 } = await import('@/lib/crypto');

        await runLogin('my-strong-password');

        expect(signAuthProofV2).toHaveBeenCalled();
        const v2Payload = vi.mocked(signAuthProofV2).mock.calls[0][1];
        expect(v2Payload.key_version).toBe(3);
        const sentProof = vi.mocked(addDevice).mock.calls[0][0].auth_proof;
        expect(sentProof.payload.key_version).toBe(3);
    });

    it('resolve returns not_found → surfaces "No account with that handle"', async () => {
        const { resolve } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({ status: 'not_found' });

        const { result } = await runLogin('any-password');
        expect(result.current.error).toMatch(/No account with that handle/);
        expect(result.current.loading).toBe(false);
    });

    it('resolve returns released → surfaces deletion date', async () => {
        const { resolve } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({
            status: 'released',
            released_at: '2026-05-01T00:00:00Z',
            available_at: '2026-05-31T00:00:00Z',
        });

        const { result } = await runLogin('any-password');
        expect(result.current.error).toMatch(/deleted on 2026-05-01/);
        expect(result.current.loading).toBe(false);
    });

    it('handle is normalised to lowercase + trimmed before resolve', async () => {
        const { resolve, addDevice } = await import('@/lib/api');
        const { useNavigate } = await import('react-router-dom');
        vi.mocked(useNavigate).mockReturnValue(vi.fn());
        vi.mocked(addDevice).mockResolvedValue({
            device_id: 'd',
            token: 't',
        });
        vi.mocked(resolve).mockResolvedValue({
            status: 'live',
            user_id: 'u',
            sharing_public_key: 'pk',
            salt: 'c2FsdA',
            kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 },
            key_version: 1,
        });

        const { useLogin } = await import('./useLogin');
        const { result } = renderHook(() => useLogin(vi.fn()));
        await act(async () => {
            await result.current.handleLogin('  ALICE-Test  ', 'my-password');
        });

        expect(resolve).toHaveBeenCalledWith('alice-test');
    });
});
