/**
 * Key backup — encrypt/upload and download/decrypt Megolm session keys.
 *
 * Session keys are encrypted with the user's backup key (AES-256-GCM)
 * and stored at `keys/{userId}/live/{sessionId}`.
 *
 * Keys follow the same compaction lifecycle as inbox messages:
 * live objects are compacted into daily CBOR archives at
 * `keys/{userId}/archive/{date}-{ULID}`. The `msg_id` field (set to
 * sessionId) enables server-side dedup during compaction.
 */

import { decode as cborDecode } from 'cbor-x';
import { storeCompact, storeGet, storeList, storePresign } from './api';
import { backupDecrypt, backupEncrypt } from './crypto';
import type { SessionManager } from './megolm-session';

interface KeyBackupEntry {
    msg_id: string;
    session_id: string;
    iv: string;
    ciphertext: string;
}

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
        msg_id: sessionId,
        session_id: sessionId,
        iv: btoa(String.fromCharCode(...encrypted.iv)),
        ciphertext: btoa(String.fromCharCode(...encrypted.ciphertext)),
    });
    const blobBytes = new TextEncoder().encode(blob);

    const key = `keys/${userId}/live/${sessionId}`;
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
    let restored = 0;

    // Restore from live keys
    const livePrefix = `keys/${userId}/live/`;
    let hadLiveKeys = false;
    try {
        const liveRes = await storeList(token, livePrefix);
        for (const key of liveRes.keys) {
            try {
                const blob = await storeGet(token, key);
                const entry = JSON.parse(
                    new TextDecoder().decode(blob),
                ) as KeyBackupEntry;
                restored += await restoreEntry(
                    entry,
                    backupKey,
                    sessionManager,
                );
            } catch (error) {
                console.error(`Failed to restore key ${key}:`, error);
            }
        }
        hadLiveKeys = liveRes.keys.length > 0;
    } catch (error) {
        console.error('Failed to list live keys:', error);
    }

    // Restore from archived keys
    const archivePrefix = `keys/${userId}/archive/`;
    try {
        const archiveRes = await storeList(token, archivePrefix);
        for (const key of archiveRes.keys) {
            try {
                const blob = await storeGet(token, key);
                const entries = cborDecode(
                    new Uint8Array(blob),
                ) as KeyBackupEntry[];
                for (const entry of entries) {
                    restored += await restoreEntry(
                        entry,
                        backupKey,
                        sessionManager,
                    );
                }
            } catch (error) {
                console.error(`Failed to restore archive ${key}:`, error);
            }
        }
    } catch (error) {
        console.error('Failed to list archive keys:', error);
    }

    // Compact live keys after the full restore so compact's deletions don't
    // race with the archive reads above (compact merges old today-archives into
    // a new one and deletes the originals).
    if (hadLiveKeys) {
        storeCompact(token, livePrefix, '~').catch(console.error);
    }

    return restored;
}

async function restoreEntry(
    entry: KeyBackupEntry,
    backupKey: CryptoKey,
    sessionManager: SessionManager,
): Promise<number> {
    const { session_id: sessionId, iv, ciphertext } = entry;

    // Skip if already known
    const existing = await sessionManager.getInbound(sessionId);
    if (existing) return 0;

    const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
    const ctBytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));

    const sessionKeyBytes = await backupDecrypt(backupKey, {
        iv: ivBytes,
        ciphertext: ctBytes,
    });
    const sessionKeyB64 = new TextDecoder().decode(sessionKeyBytes);

    // addInbound uses from_session_key, which is correct for session keys stored
    // in key backup. importInbound uses from_export (ratchet-forward format) and
    // would reject a raw session key.
    const [, isNew] = await sessionManager.addInbound(
        'unknown',
        'unknown',
        sessionKeyB64,
    );
    return isNew ? 1 : 0;
}
