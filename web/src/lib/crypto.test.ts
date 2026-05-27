import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { describe, expect, it } from 'vitest';
import {
    backupDecrypt,
    backupEncrypt,
    canonicalizeForSign,
    deriveKeys,
    eciesDecrypt,
    eciesEncrypt,
    generateBackupSecret,
    importSharingPublicKey,
    signAuthProof,
    signAuthProofV2,
    verifyAuthProof,
} from './crypto.js';

describe('Web Crypto', () => {
    describe('BIP39 mnemonic', () => {
        it('roundtrips 128-bit secret through 12-word mnemonic', () => {
            const secret = generateBackupSecret();
            const mnemonic = entropyToMnemonic(secret, wordlist);
            expect(mnemonic.split(' ')).toHaveLength(12);

            const recovered = mnemonicToEntropy(mnemonic, wordlist);
            expect(new Uint8Array(recovered)).toEqual(secret);
        });
    });

    describe('HKDF key derivation', () => {
        it('derives deterministic keys from same secret', async () => {
            const secret = generateBackupSecret();
            const keys1 = await deriveKeys(secret);
            const keys2 = await deriveKeys(secret);

            expect(keys1.auth.publicKeyBytes).toEqual(
                keys2.auth.publicKeyBytes,
            );
            expect(keys1.sharing.publicKeyBytes).toEqual(
                keys2.sharing.publicKeyBytes,
            );
        });

        it('derives different keys from different secrets', async () => {
            const keys1 = await deriveKeys(generateBackupSecret());
            const keys2 = await deriveKeys(generateBackupSecret());

            expect(keys1.auth.publicKeyBytes).not.toEqual(
                keys2.auth.publicKeyBytes,
            );
            expect(keys1.sharing.publicKeyBytes).not.toEqual(
                keys2.sharing.publicKeyBytes,
            );
        });

        it('auth public key is 32 bytes (Ed25519), sharing is 65 bytes (P-256 uncompressed)', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            expect(keys.auth.publicKeyBytes).toHaveLength(32);
            expect(keys.sharing.publicKeyBytes).toHaveLength(65);
            expect(keys.sharing.publicKeyBytes[0]).toBe(0x04);
        });

        it('sharing private key is non-extractable', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            expect(keys.sharing.privateKey.extractable).toBe(false);
            await expect(
                crypto.subtle.exportKey('jwk', keys.sharing.privateKey),
            ).rejects.toThrow();
        });
    });

    describe('Ed25519 auth proof', () => {
        it('signs and verifies', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            const payload = {
                user_id: 'user01',
                device_id: 'dev01',
                timestamp: '2025-01-15T10:30:00Z',
            };

            const sig = await signAuthProof(keys.auth.privateKey, payload);
            expect(sig).toHaveLength(64);

            const valid = await verifyAuthProof(
                keys.auth.publicKey,
                payload,
                sig,
            );
            expect(valid).toBe(true);
        });

        it('rejects tampered payload', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            const payload = {
                user_id: 'user01',
                device_id: 'dev01',
                timestamp: '2025-01-15T10:30:00Z',
            };

            const sig = await signAuthProof(keys.auth.privateKey, payload);
            const tampered = { ...payload, user_id: 'user02' };
            const valid = await verifyAuthProof(
                keys.auth.publicKey,
                tampered,
                sig,
            );
            expect(valid).toBe(false);
        });

        it('rejects wrong key', async () => {
            const keys1 = await deriveKeys(generateBackupSecret());
            const keys2 = await deriveKeys(generateBackupSecret());
            const payload = {
                user_id: 'user01',
                device_id: 'dev01',
                timestamp: '2025-01-15T10:30:00Z',
            };

            const sig = await signAuthProof(keys1.auth.privateKey, payload);
            const valid = await verifyAuthProof(
                keys2.auth.publicKey,
                payload,
                sig,
            );
            expect(valid).toBe(false);
        });
    });

    describe('JCS canonicalization (RFC 8785)', () => {
        it('sorts object keys lexicographically with no whitespace', () => {
            const bytes = canonicalizeForSign({ b: 1, a: 2 });
            expect(new TextDecoder().decode(bytes)).toBe('{"a":2,"b":1}');
        });

        it('sorts nested keys but preserves array order', () => {
            const bytes = canonicalizeForSign({
                z: [3, 1, 2],
                a: { d: 4, c: 5 },
            });
            expect(new TextDecoder().decode(bytes)).toBe(
                '{"a":{"c":5,"d":4},"z":[3,1,2]}',
            );
        });

        it('orders the auth-proof payload deterministically regardless of insertion order', () => {
            const payload = {
                user_id: 'u1',
                device_id: 'd1',
                timestamp: '2025-01-15T10:30:00Z',
                key_version: 2,
            };
            expect(new TextDecoder().decode(canonicalizeForSign(payload))).toBe(
                '{"device_id":"d1","key_version":2,"timestamp":"2025-01-15T10:30:00Z","user_id":"u1"}',
            );
        });
    });

    describe('v2 auth proof (signAuthProofV2)', () => {
        it('round-trips against a manual verifier over the canonical bytes', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            const payload = {
                user_id: 'u1',
                device_id: 'd1',
                timestamp: '2025-01-15T10:30:00Z',
                key_version: 2,
            };

            const sig = await signAuthProofV2(keys.auth.privateKey, payload);
            expect(sig).toHaveLength(64);

            const data = canonicalizeForSign(payload);
            const valid = await crypto.subtle.verify(
                { name: 'Ed25519' },
                keys.auth.publicKey,
                sig as unknown as BufferSource,
                data as unknown as BufferSource,
            );
            expect(valid).toBe(true);
        });

        it('signature does not verify against a different key_version', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            const payload = {
                user_id: 'u1',
                device_id: 'd1',
                timestamp: '2025-01-15T10:30:00Z',
                key_version: 2,
            };
            const sig = await signAuthProofV2(keys.auth.privateKey, payload);

            const tampered = canonicalizeForSign({
                ...payload,
                key_version: 3,
            });
            const valid = await crypto.subtle.verify(
                { name: 'Ed25519' },
                keys.auth.publicKey,
                sig as unknown as BufferSource,
                tampered as unknown as BufferSource,
            );
            expect(valid).toBe(false);
        });
    });

    describe('ECIES key share encryption', () => {
        it('encrypts and decrypts a session key', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            const sessionKey = crypto.getRandomValues(new Uint8Array(128));

            const encrypted = await eciesEncrypt(
                keys.sharing.publicKey,
                sessionKey,
            );
            expect(encrypted.ephemeralKey).toHaveLength(65);
            expect(encrypted.iv).toHaveLength(12);

            const decrypted = await eciesDecrypt(
                keys.sharing.privateKey,
                encrypted,
            );
            expect(decrypted).toEqual(sessionKey);
        });

        it('wrong recipient cannot decrypt', async () => {
            const alice = await deriveKeys(generateBackupSecret());
            const bob = await deriveKeys(generateBackupSecret());
            const sessionKey = crypto.getRandomValues(new Uint8Array(128));

            const encrypted = await eciesEncrypt(
                alice.sharing.publicKey,
                sessionKey,
            );
            await expect(
                eciesDecrypt(bob.sharing.privateKey, encrypted),
            ).rejects.toThrow();
        });

        it('each encryption produces different ciphertext', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            const sessionKey = crypto.getRandomValues(new Uint8Array(128));

            const e1 = await eciesEncrypt(keys.sharing.publicKey, sessionKey);
            const e2 = await eciesEncrypt(keys.sharing.publicKey, sessionKey);

            expect(e1.ephemeralKey).not.toEqual(e2.ephemeralKey);
            expect(e1.ciphertext).not.toEqual(e2.ciphertext);
        });
    });

    describe('AES-256-GCM key backup', () => {
        it('encrypts and decrypts', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            const data = new TextEncoder().encode('megolm-session-key-base64');

            const encrypted = await backupEncrypt(keys.backupKey, data);
            const decrypted = await backupDecrypt(keys.backupKey, encrypted);
            expect(decrypted).toEqual(data);
        });

        it('wrong key cannot decrypt', async () => {
            const keys1 = await deriveKeys(generateBackupSecret());
            const keys2 = await deriveKeys(generateBackupSecret());
            const data = new TextEncoder().encode('megolm-session-key-base64');

            const encrypted = await backupEncrypt(keys1.backupKey, data);
            await expect(
                backupDecrypt(keys2.backupKey, encrypted),
            ).rejects.toThrow();
        });
    });

    describe('full chain: mnemonic → keys → ECIES → decrypt', () => {
        it('Alice registers, Bob encrypts key share, Alice decrypts', async () => {
            // Alice registers: generate mnemonic, derive keys
            const aliceSecret = generateBackupSecret();
            const mnemonic = entropyToMnemonic(aliceSecret, wordlist);
            const aliceKeys = await deriveKeys(aliceSecret);

            // Alice publishes sharing public key bytes in profile.json
            const profilePubKeyBytes = aliceKeys.sharing.publicKeyBytes;

            // Bob resolves Alice's profile, imports her public key
            const alicePub = await importSharingPublicKey(profilePubKeyBytes);

            // Bob encrypts a Megolm session key for Alice
            const sessionKey = new TextEncoder().encode(
                'base64-megolm-session-key',
            );
            const encrypted = await eciesEncrypt(alicePub, sessionKey);

            // Alice on a new device: recover keys from mnemonic
            const recoveredSecret = mnemonicToEntropy(mnemonic, wordlist);
            const restoredKeys = await deriveKeys(
                new Uint8Array(recoveredSecret),
            );

            // Alice decrypts the key share
            const decrypted = await eciesDecrypt(
                restoredKeys.sharing.privateKey,
                encrypted,
            );
            expect(new TextDecoder().decode(decrypted)).toBe(
                'base64-megolm-session-key',
            );
        });

        it('key backup survives device restore', async () => {
            // Alice registers and backs up a session key
            const aliceSecret = generateBackupSecret();
            const mnemonic = entropyToMnemonic(aliceSecret, wordlist);
            const keys = await deriveKeys(aliceSecret);

            const sessionKey = new TextEncoder().encode('session-key-data');
            const backup = await backupEncrypt(keys.backupKey, sessionKey);

            // Alice restores on new device from mnemonic
            const restoredKeys = await deriveKeys(
                new Uint8Array(mnemonicToEntropy(mnemonic, wordlist)),
            );

            // Decrypts the backup
            const restored = await backupDecrypt(
                restoredKeys.backupKey,
                backup,
            );
            expect(new TextDecoder().decode(restored)).toBe('session-key-data');
        });
    });
});
