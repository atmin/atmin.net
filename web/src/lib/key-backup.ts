/**
 * Key backup — encrypt/upload and download/decrypt Megolm session keys.
 *
 * Session keys are encrypted with the user's *current* backup key
 * (AES-256-GCM) and stored at `keys/{userId}/live/{base64url(sessionId)}`
 * with a versioned envelope (`{v, iv, ciphertext, session_id, msg_id}`).
 * The key segment is base64url (object-name-safe); the envelope body carries
 * the *raw* session_id, which is what restore reads (see paths.ts / I10).
 *
 * On restore, each blob's `v` tells the reader which key encrypted it.
 * For `v == currentKeyVersion` (the common case) the in-hand backup key
 * decrypts directly. For `v < currentKeyVersion` (the user rotated and
 * historical blobs are still in storage) the reader walks
 * `keys/{uid}/key_chain.json` backwards to recover that older key, then
 * decrypts. See ADR-0012 — Backup migration.
 *
 * Archives (CBOR arrays) may mix versions when a rotation lands between
 * compactions; the reader dispatches per entry independently.
 */

import { decode as cborDecode } from 'cbor-x';
import {
    putWithRetry,
    storeCompact,
    storeGet,
    storeList,
    storePresign,
} from './api';
import { backupDecrypt, backupEncrypt } from './crypto';
import {
    type KeyBackupEnvelopeV2,
    parseKeyBackupEnvelope,
    wrapKeyBackupEnvelope,
} from './key-backup-envelope';
import { fetchChain, type KeyChain, resolveBackupKey } from './key-chain';
import type { SessionManager } from './megolm-session';
import { path } from './paths';

export async function backupSessionKey(
    token: string,
    userId: string,
    sessionId: string,
    sessionKeyB64: string,
    backupKey: CryptoKey,
    keyVersion: number,
): Promise<void> {
    const plaintext = new TextEncoder().encode(sessionKeyB64);
    const encrypted = await backupEncrypt(backupKey, plaintext);
    const env = wrapKeyBackupEnvelope(
        keyVersion,
        encrypted.iv,
        encrypted.ciphertext,
        sessionId,
    );
    const blobBytes = new TextEncoder().encode(JSON.stringify(env));

    const key = path.keyBackup(userId, sessionId);
    const { presigned_url } = await storePresign(token, key, blobBytes.length);

    await putWithRetry(presigned_url, blobBytes);
}

/**
 * Outcome of a restore pass.
 * - `restored`: session keys successfully recovered into the manager.
 * - `failed`: key-backup blobs we found but could not recover (corrupt
 *   ciphertext, undecryptable, unparseable, or an unresolvable key
 *   version). Each is a session whose history won't surface on this
 *   device — surfaced to the user rather than silently dropped (I6).
 *   List/transport failures are NOT counted here (they're transient and
 *   retried on the next sync); only per-blob failures are.
 */
export interface RestoreResult {
    restored: number;
    failed: number;
}

export async function restoreSessionKeys(
    token: string,
    userId: string,
    backupKey: CryptoKey,
    currentVersion: number,
    sessionManager: SessionManager,
): Promise<RestoreResult> {
    let restored = 0;
    let failed = 0;

    // Chain is only needed when we see a blob with `v < currentVersion`.
    // Fetch eagerly once; absence is cheap (one storeGet → 404 → empty).
    const chain = currentVersion > 1 ? await fetchChain(token, userId) : null;
    const keyForVersion = new Map<number, CryptoKey>([
        [currentVersion, backupKey],
    ]);

    const getKey = async (v: number): Promise<CryptoKey> => {
        if (v === currentVersion) return backupKey;
        const memo = keyForVersion.get(v);
        if (memo) return memo;
        if (!chain) {
            throw new Error(
                `key backup: blob v${v} but account at v${currentVersion} with no chain`,
            );
        }
        const resolved = await resolveBackupKey(
            userId,
            backupKey,
            currentVersion,
            v,
            chain,
        );
        keyForVersion.set(v, resolved);
        return resolved;
    };

    // Restore from live keys
    const livePrefix = path.keysLive(userId);
    let hadLiveKeys = false;
    try {
        const liveRes = await storeList(token, livePrefix);
        for (const key of liveRes.keys) {
            try {
                const blob = await storeGet(token, key);
                const parsed = parseKeyBackupEnvelope(
                    JSON.parse(new TextDecoder().decode(blob)),
                );
                const decryptor = await getKey(parsed.v);
                restored += await restoreEntry(
                    parsed.sessionId,
                    parsed.iv,
                    parsed.ciphertext,
                    decryptor,
                    sessionManager,
                );
            } catch (error) {
                failed += 1;
                console.error(`Failed to restore key ${key}:`, error);
            }
        }
        hadLiveKeys = liveRes.keys.length > 0;
    } catch (error) {
        console.error('Failed to list live keys:', error);
    }

    // Restore from archived keys. Each CBOR entry self-describes its `v`;
    // a single archive can hold v=1 and v=2 entries when a rotation lands
    // between compactions (ADR-0012).
    const archivePrefix = path.keysArchive(userId);
    try {
        const archiveRes = await storeList(token, archivePrefix);
        for (const key of archiveRes.keys) {
            try {
                const blob = await storeGet(token, key);
                const entries = cborDecode(
                    new Uint8Array(blob),
                ) as Array<unknown>;
                for (const raw of entries) {
                    try {
                        const parsed = parseKeyBackupEnvelope(raw);
                        const decryptor = await getKey(parsed.v);
                        restored += await restoreEntry(
                            parsed.sessionId,
                            parsed.iv,
                            parsed.ciphertext,
                            decryptor,
                            sessionManager,
                        );
                    } catch (entryErr) {
                        failed += 1;
                        console.error('Failed archive entry:', entryErr);
                    }
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

    return { restored, failed };
}

async function restoreEntry(
    sessionId: string | undefined,
    iv: Uint8Array,
    ciphertext: Uint8Array,
    backupKey: CryptoKey,
    sessionManager: SessionManager,
): Promise<number> {
    if (!sessionId) {
        console.warn('key backup entry missing session_id; skipping');
        return 0;
    }

    // Skip if already known
    const existing = await sessionManager.getInbound(sessionId);
    if (existing) return 0;

    const sessionKeyBytes = await backupDecrypt(backupKey, {
        iv,
        ciphertext,
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

// Re-exports for callers that previously imported the envelope/chain types
// from key-backup directly. New code should import from the source modules.
export type { KeyBackupEnvelopeV2, KeyChain };
