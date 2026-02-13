import { describe, it, expect } from 'vitest';
import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import {
    generateBackupSecret,
    deriveKeys,
    signAuthProof,
    verifyAuthProof,
    eciesEncrypt,
    eciesDecrypt,
    backupEncrypt,
    backupDecrypt,
    importX25519PublicKey,
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

        it('auth and sharing public keys are 32 bytes', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            expect(keys.auth.publicKeyBytes).toHaveLength(32);
            expect(keys.sharing.publicKeyBytes).toHaveLength(32);
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

    describe('ECIES key share encryption', () => {
        it('encrypts and decrypts a session key', async () => {
            const keys = await deriveKeys(generateBackupSecret());
            const sessionKey = crypto.getRandomValues(new Uint8Array(128));

            const encrypted = await eciesEncrypt(
                keys.sharing.publicKey,
                sessionKey,
            );
            expect(encrypted.ephemeralKey).toHaveLength(32);
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
            const alicePub = await importX25519PublicKey(profilePubKeyBytes);

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
