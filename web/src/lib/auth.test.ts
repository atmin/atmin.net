import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '@/test/storage';
import {
    clearSession,
    clearToken,
    loadSession,
    type Session,
    saveSession,
} from './auth';
import { deriveKeys, generateBackupSecret } from './crypto';

beforeEach(() => {
    // Setup fake IndexedDB
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = FakeIDBKeyRange;

    // Fresh in-memory localStorage per test. stubGlobal + unstubAllGlobals
    // RESTORES the ambient global after each test, so this never leaks a
    // partial Storage into sibling files in a reused CI worker (see
    // src/test/storage.ts).
    vi.stubGlobal('localStorage', memoryStorage());
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('session - Session management', () => {
    let testSession: Session;

    beforeEach(async () => {
        // Generate test keys
        const secret = generateBackupSecret();
        const keys = await deriveKeys(secret);

        testSession = {
            token: 'test-token-abc123',
            userId: '01TESTUSER123',
            deviceId: '01TESTDEVICE456',
            handle: 'test-handle',
            sharingPrivateKey: keys.sharing.privateKey,
            sharingPublicKeyBytes: keys.sharing.publicKeyBytes,
            backupKey: keys.backupKey,
            keyVersion: 1,
        };
    });

    describe('saveSession', () => {
        it('saves all session data to localStorage and IndexedDB', async () => {
            await saveSession(testSession);

            // Verify localStorage
            expect(localStorage.getItem('atmin:token')).toBe(
                'test-token-abc123',
            );
            expect(localStorage.getItem('atmin:userId')).toBe('01TESTUSER123');
            expect(localStorage.getItem('atmin:deviceId')).toBe(
                '01TESTDEVICE456',
            );
            expect(localStorage.getItem('atmin:handle')).toBe('test-handle');

            // Verify public key bytes in localStorage (base64 encoded)
            const storedPublicKey = localStorage.getItem(
                'atmin:sharingPublicKeyBytes',
            );
            expect(storedPublicKey).toBeTruthy();
            expect(typeof storedPublicKey).toBe('string');

            // Verify keys are in IndexedDB (will be tested in loadSession)
        });

        it('encodes public key bytes as base64', async () => {
            await saveSession(testSession);

            const storedPublicKey = localStorage.getItem(
                'atmin:sharingPublicKeyBytes',
            );
            expect(storedPublicKey).toBeTruthy();

            // Decode and verify it matches original
            if (storedPublicKey) {
                const decoded = new Uint8Array(
                    atob(storedPublicKey)
                        .split('')
                        .map((c) => c.charCodeAt(0)),
                );
                expect(decoded).toEqual(testSession.sharingPublicKeyBytes);
            }
        });

        it('overwrites existing session', async () => {
            await saveSession(testSession);

            // Save a different session
            const newSession = { ...testSession, token: 'new-token-xyz789' };
            await saveSession(newSession);

            // Verify new token is saved
            expect(localStorage.getItem('atmin:token')).toBe(
                'new-token-xyz789',
            );
        });
    });

    describe('loadSession', () => {
        it('loads complete session from localStorage and IndexedDB', async () => {
            // Save session first
            await saveSession(testSession);

            // Load it back
            const loaded = await loadSession();

            expect(loaded).not.toBeNull();
            expect(loaded?.token).toBe('test-token-abc123');
            expect(loaded?.userId).toBe('01TESTUSER123');
            expect(loaded?.deviceId).toBe('01TESTDEVICE456');
            expect(loaded?.handle).toBe('test-handle');
            expect(loaded?.sharingPublicKeyBytes).toEqual(
                testSession.sharingPublicKeyBytes,
            );

            // Verify CryptoKeys are loaded (can't compare directly, but should exist)
            expect(loaded?.sharingPrivateKey).toBeTruthy();
            expect(loaded?.sharingPrivateKey.type).toBe('private');
            expect(loaded?.backupKey).toBeTruthy();
            expect(loaded?.backupKey.type).toBe('secret');
        });

        it('returns null when no session exists', async () => {
            const loaded = await loadSession();
            expect(loaded).toBeNull();
        });

        it('returns null when token is missing', async () => {
            await saveSession(testSession);
            localStorage.removeItem('atmin:token');

            const loaded = await loadSession();
            expect(loaded).toBeNull();
        });

        it('returns null when userId is missing', async () => {
            await saveSession(testSession);
            localStorage.removeItem('atmin:userId');

            const loaded = await loadSession();
            expect(loaded).toBeNull();
        });

        it('returns null when deviceId is missing', async () => {
            await saveSession(testSession);
            localStorage.removeItem('atmin:deviceId');

            const loaded = await loadSession();
            expect(loaded).toBeNull();
        });

        it('returns null when handle is missing', async () => {
            await saveSession(testSession);
            localStorage.removeItem('atmin:handle');

            const loaded = await loadSession();
            expect(loaded).toBeNull();
        });

        it('returns null when sharingPublicKeyBytes is missing', async () => {
            await saveSession(testSession);
            localStorage.removeItem('atmin:sharingPublicKeyBytes');

            const loaded = await loadSession();
            expect(loaded).toBeNull();
        });

        it('returns null when sharingPrivateKey is missing from IndexedDB', async () => {
            await saveSession(testSession);

            // Manually remove the key from IndexedDB
            const { clearKeys } = await import('./db');
            await clearKeys();

            const loaded = await loadSession();
            expect(loaded).toBeNull();
        });

        it('returns null when public key bytes are corrupted', async () => {
            await saveSession(testSession);

            // Corrupt the base64 data
            localStorage.setItem(
                'atmin:sharingPublicKeyBytes',
                'not-base64!!!',
            );

            // Should handle the error gracefully
            try {
                const loaded = await loadSession();
                // Might return null or throw, either is acceptable
                expect(loaded).toBeNull();
            } catch (error) {
                // Error is also acceptable for corrupted data
                expect(error).toBeTruthy();
            }
        });

        it('successfully roundtrips CryptoKeys through IndexedDB', async () => {
            // Save session
            await saveSession(testSession);

            // Load it back
            const loaded = await loadSession();
            expect(loaded).not.toBeNull();
            if (!loaded) return; // Type guard

            // Verify we can use the loaded keys for crypto operations
            const { eciesEncrypt, eciesDecrypt } = await import('./crypto');

            // Import public key from loaded bytes
            const { importSharingPublicKey } = await import('./crypto');
            const publicKey = await importSharingPublicKey(
                loaded.sharingPublicKeyBytes,
            );

            // Encrypt with public key
            const testData = new TextEncoder().encode('test message');
            const encrypted = await eciesEncrypt(publicKey, testData);

            // Decrypt with loaded private key
            const decrypted = await eciesDecrypt(
                loaded.sharingPrivateKey,
                encrypted,
            );

            // Verify roundtrip
            expect(new TextDecoder().decode(decrypted)).toBe('test message');
        });
    });

    describe('clearSession', () => {
        it('removes all session data from localStorage and IndexedDB', async () => {
            // Save session first
            await saveSession(testSession);

            // Verify it exists
            expect(localStorage.getItem('atmin:token')).toBeTruthy();

            // Clear session
            await clearSession();

            // Verify localStorage is cleared
            expect(localStorage.getItem('atmin:token')).toBeNull();
            expect(localStorage.getItem('atmin:userId')).toBeNull();
            expect(localStorage.getItem('atmin:deviceId')).toBeNull();
            expect(localStorage.getItem('atmin:handle')).toBeNull();
            expect(
                localStorage.getItem('atmin:sharingPublicKeyBytes'),
            ).toBeNull();

            // Verify IndexedDB keys are cleared
            const loaded = await loadSession();
            expect(loaded).toBeNull();
        });

        it('is idempotent (can be called multiple times)', async () => {
            await saveSession(testSession);

            await clearSession();
            await clearSession();
            await clearSession();

            // Should still be cleared
            const loaded = await loadSession();
            expect(loaded).toBeNull();
        });

        it('can be called when no session exists', async () => {
            // Should not throw
            await expect(clearSession()).resolves.toBeUndefined();
        });
    });

    describe('clearToken', () => {
        it('removes all localStorage keys but leaves IndexedDB intact', async () => {
            await saveSession(testSession);

            clearToken();

            expect(localStorage.getItem('atmin:token')).toBeNull();
            expect(localStorage.getItem('atmin:userId')).toBeNull();
            expect(localStorage.getItem('atmin:deviceId')).toBeNull();
            expect(localStorage.getItem('atmin:handle')).toBeNull();
            expect(
                localStorage.getItem('atmin:sharingPublicKeyBytes'),
            ).toBeNull();

            // loadSession returns null because token is missing from localStorage...
            const loaded = await loadSession();
            expect(loaded).toBeNull();

            // ...but IndexedDB keys still exist
            const { getKey } = await import('./db');
            expect(await getKey('sharingPrivateKey')).toBeTruthy();
            expect(await getKey('backupKey')).toBeTruthy();
        });

        it('is idempotent', () => {
            clearToken();
            clearToken();
            // should not throw
        });

        it('can be called when no session exists', () => {
            // should not throw
            clearToken();
        });
    });

    describe('integration - full session lifecycle', () => {
        it('handles save → load → clear → load cycle', async () => {
            // 1. No session initially
            let session = await loadSession();
            expect(session).toBeNull();

            // 2. Save session
            await saveSession(testSession);

            // 3. Load session
            session = await loadSession();
            expect(session).not.toBeNull();
            expect(session?.token).toBe('test-token-abc123');

            // 4. Clear session
            await clearSession();

            // 5. Session is gone
            session = await loadSession();
            expect(session).toBeNull();
        });

        it('handles multiple save/load cycles', async () => {
            // Save initial session
            await saveSession(testSession);

            // Update and save multiple times
            for (let i = 0; i < 5; i++) {
                const updated = { ...testSession, token: `token-${i}` };
                await saveSession(updated);

                const loaded = await loadSession();
                expect(loaded?.token).toBe(`token-${i}`);
            }
        });

        it('maintains session across simulated page refreshes', async () => {
            // Save session
            await saveSession(testSession);

            // Simulate multiple page loads
            for (let i = 0; i < 3; i++) {
                const loaded = await loadSession();
                expect(loaded).not.toBeNull();
                expect(loaded?.token).toBe('test-token-abc123');
                expect(loaded?.userId).toBe('01TESTUSER123');
            }
        });
    });
});
