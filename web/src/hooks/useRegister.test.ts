// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', async () => {
    const actual =
        await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
    return {
        ...actual,
        register: vi.fn(),
    };
});

vi.mock('@/lib/auth', () => ({
    saveSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/argon2-worker.client', () => ({
    argonStretch: vi.fn().mockResolvedValue(new Uint8Array(16).fill(5)),
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
    generateSalt: vi.fn().mockReturnValue(new Uint8Array(16).fill(7)),
    DEFAULT_KDF: { type: 'argon2id', m: 65536, t: 3, p: 1 },
}));

vi.mock('@/lib/utils', () => ({
    detectDeviceLabel: vi.fn().mockReturnValue('test-device'),
}));

describe('useRegister', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('starts on the enter step with empty credentials', async () => {
        const { useRegister } = await import('./useRegister');
        const { result } = renderHook(() => useRegister(vi.fn()));

        expect(result.current.step).toBe('enter');
        expect(result.current.password).toBe('');
        expect(result.current.acknowledged).toBe(false);
    });

    it('stretches the password through Argon2id and registers with salt + kdf', async () => {
        const { register } = await import('@/lib/api');
        const { argonStretch } = await import('@/lib/argon2-worker.client');
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

        act(() => {
            result.current.setPassword('hunter2-strong');
            result.current.setConfirm('hunter2-strong');
            result.current.setAcknowledged(true);
        });

        await act(async () => {
            await result.current.handleRegister();
        });

        expect(argonStretch).toHaveBeenCalledWith(
            'hunter2-strong',
            new Uint8Array(16).fill(7),
            { type: 'argon2id', m: 65536, t: 3, p: 1 },
        );

        const payload = vi.mocked(register).mock.calls[0][0];
        expect(payload).toMatchObject({
            salt: 'encoded',
            kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 },
        });
        expect(payload.auth_public_key).toBeDefined();
        expect(payload.sharing_public_key).toBeDefined();

        expect(saveSession).toHaveBeenCalled();
        expect(onSuccess).toHaveBeenCalled();
        expect(result.current.step).toBe('done');
    });

    it('returns to the enter step and surfaces an error if derivation fails', async () => {
        const { argonStretch } = await import('@/lib/argon2-worker.client');
        vi.mocked(argonStretch).mockRejectedValueOnce(new Error('worker died'));

        const { useRegister } = await import('./useRegister');
        const { result } = renderHook(() => useRegister(vi.fn()));

        act(() => {
            result.current.setPassword('hunter2-strong');
        });
        await act(async () => {
            await result.current.handleRegister();
        });

        expect(result.current.step).toBe('enter');
        expect(result.current.error).toContain('worker died');
    });
});
