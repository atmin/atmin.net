/**
 * Key backup — encrypt/upload and download/decrypt Megolm session keys.
 *
 * Session keys are encrypted with the user's backup key (AES-256-GCM)
 * and stored at `backups/{userId}/keys/live/{sessionId}`.
 *
 * Note: key backups are NOT compacted because the sessionId lives in the
 * key path and would be lost in a CBOR archive blob. They are small and
 * few (one per Megolm session) so compaction is unnecessary.
 */

import { storeGet, storeList, storePresign } from './api';
import { backupDecrypt, backupEncrypt } from './crypto';
import type { SessionManager } from './megolm-session';

export async function backupSessionKey(
    token: string,
    userId: string,
    sessionId: string,
    sessionKeyB64: string,
    backupKey: CryptoKey,
): Promise<void> {
    const plaintext = new TextEncoder().encode(sessionKeyB64);
    const encrypted = await backupEncrypt(backupKey, plaintext);
    const blob = JSON.stringify({
        iv: btoa(String.fromCharCode(...encrypted.iv)),
        ciphertext: btoa(String.fromCharCode(...encrypted.ciphertext)),
    });
    const blobBytes = new TextEncoder().encode(blob);

    const key = `backups/${userId}/keys/live/${sessionId}`;
    const { presigned_url } = await storePresign(token, key, blobBytes.length);

    await fetch(presigned_url, {
        method: 'PUT',
        body: blobBytes,
    });
}

export async function restoreSessionKeys(
    token: string,
    userId: string,
    backupKey: CryptoKey,
    sessionManager: SessionManager,
): Promise<number> {
    const prefix = `backups/${userId}/keys/live/`;
    const listRes = await storeList(token, prefix);

    let restored = 0;

    for (const key of listRes.keys) {
        const sessionId = key.slice(prefix.length);

        // Skip if already known
        const existing = await sessionManager.getInbound(sessionId);
        if (existing) continue;

        try {
            const blob = await storeGet(token, key);
            const { iv, ciphertext } = JSON.parse(
                new TextDecoder().decode(blob),
            );

            const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
            const ctBytes = Uint8Array.from(atob(ciphertext), (c) =>
                c.charCodeAt(0),
            );

            const sessionKeyBytes = await backupDecrypt(backupKey, {
                iv: ivBytes,
                ciphertext: ctBytes,
            });
            const sessionKeyB64 = new TextDecoder().decode(sessionKeyBytes);

            await sessionManager.importInbound(
                sessionId,
                'unknown',
                'unknown',
                sessionKeyB64,
            );
            restored++;
        } catch (error) {
            console.error(`Failed to restore key ${key}:`, error);
        }
    }

    return restored;
}
