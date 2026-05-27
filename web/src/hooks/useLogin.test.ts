// @vitest-environment happy-dom
import { entropyToMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// @scure/bip39 is deliberately NOT mocked: the autodetect matrix needs
// the real wordlist + checksum validation.
vi.mock('@/lib/api', () => ({
    addDevice: vi.fn(),
    resolve: vi.fn(),
}));

vi.mock('@/lib/auth', () => ({
    saveSession: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/argon2-worker.client', () => ({
    argonStretch: vi.fn().mockResolvedValue(new Uint8Array(16).fill(5)),
}));

vi.mock('@/lib/crypto', () => ({
    base64UrlEncode: vi.fn().mockReturnValue('encoded'),
    base64UrlDecode: vi.fn().mockReturnValue(new Uint8Array(16)),
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
    signAuthProof: vi.fn().mockResolvedValue(new Uint8Array([1, 1, 1])),
    signAuthProofV2: vi.fn().mockResolvedValue(new Uint8Array([2, 2, 2])),
}));

vi.mock('@/lib/utils', () => ({
    detectDeviceLabel: vi.fn().mockReturnValue('test-device'),
}));

vi.mock('react-router-dom', () => ({
    useNavigate: vi.fn(),
}));

// A real 12-word mnemonic with a valid checksum (all-zero entropy).
const VALID_MNEMONIC = entropyToMnemonic(new Uint8Array(16), wordlist);

describe('isLegacyMnemonic', () => {
    it('accepts 12 valid words with a valid checksum', async () => {
        const { isLegacyMnemonic } = await import('./useLogin');
        expect(isLegacyMnemonic(VALID_MNEMONIC)).toBe(true);
    });

    it('rejects 12 valid words with a broken checksum', async () => {
        const { isLegacyMnemonic } = await import('./useLogin');
        // 12 "abandon" words are all in the wordlist but fail the checksum.
        const broken = Array(12).fill('abandon').join(' ');
        expect(isLegacyMnemonic(broken)).toBe(false);
    });

    it('rejects a plain password', async () => {
        const { isLegacyMnemonic } = await import('./useLogin');
        expect(isLegacyMnemonic('password123')).toBe(false);
    });

    it('rejects 11 valid words', async () => {
        const { isLegacyMnemonic } = await import('./useLogin');
        const eleven = VALID_MNEMONIC.split(' ').slice(0, 11).join(' ');
        expect(isLegacyMnemonic(eleven)).toBe(false);
    });

    it('normalises extra whitespace between words', async () => {
        const { isLegacyMnemonic } = await import('./useLogin');
        const messy = `  ${VALID_MNEMONIC.split(' ').join('   ')}  `;
        expect(isLegacyMnemonic(messy)).toBe(true);
    });
});

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

    it('legacy mnemonic login decodes directly and emits a v1 auth proof', async () => {
        const { resolve } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({
            user_id: 'user-resolved',
            sharing_public_key: 'pk',
        });
        const { argonStretch } = await import('@/lib/argon2-worker.client');
        const { signAuthProof, signAuthProofV2 } = await import('@/lib/crypto');

        const { onSuccess } = await runLogin(VALID_MNEMONIC);

        expect(argonStretch).not.toHaveBeenCalled();
        expect(signAuthProof).toHaveBeenCalled();
        expect(signAuthProofV2).not.toHaveBeenCalled();
        expect(onSuccess).toHaveBeenCalled();
    });

    it('v2 password login at key_version 1 stretches and emits a v1 auth proof', async () => {
        const { resolve } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({
            user_id: 'user-resolved',
            sharing_public_key: 'pk',
            salt: 'c2FsdA',
            kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 },
            key_version: 1,
        });
        const { argonStretch } = await import('@/lib/argon2-worker.client');
        const { signAuthProof, signAuthProofV2 } = await import('@/lib/crypto');

        await runLogin('my-strong-password');

        expect(argonStretch).toHaveBeenCalled();
        expect(signAuthProof).toHaveBeenCalled();
        expect(signAuthProofV2).not.toHaveBeenCalled();
    });

    it('v2 password login at key_version > 1 emits a v2 auth proof with key_version', async () => {
        const { resolve, addDevice } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({
            user_id: 'user-resolved',
            sharing_public_key: 'pk',
            salt: 'c2FsdA',
            kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 },
            key_version: 3,
        });
        const { signAuthProof, signAuthProofV2 } = await import('@/lib/crypto');

        await runLogin('my-strong-password');

        expect(signAuthProofV2).toHaveBeenCalled();
        expect(signAuthProof).not.toHaveBeenCalled();
        const v2Payload = vi.mocked(signAuthProofV2).mock.calls[0][1];
        expect(v2Payload.key_version).toBe(3);
        // The auth_proof sent to the server also carries key_version.
        const sentProof = vi.mocked(addDevice).mock.calls[0][0].auth_proof;
        expect(
            (sentProof.payload as { key_version?: number }).key_version,
        ).toBe(3);
    });

    it('password login against a legacy (v1) account asks for the recovery phrase', async () => {
        const { resolve } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({
            user_id: 'user-resolved',
            sharing_public_key: 'pk',
        });

        const { result } = await runLogin('a-password-not-a-mnemonic');
        expect(result.current.error).toContain('Recovery phrase required');
        expect(result.current.loading).toBe(false);
    });
});
