/**
 * Contact backup — encrypt/upload and download/decrypt the contacts list.
 *
 * Contacts are encrypted with the user's *current* backup key
 * (AES-256-GCM) and stored at `users/{userId}/contacts.json` in the
 * versioned envelope shared with key backup (ADR-0012). After a
 * rotation, a stale read sees `v: oldKv` and recovers the old backup
 * key via the chain walker; the next write re-wraps with the new key.
 *
 * Last-write-wins. All devices read the same file.
 */

import { putWithRetry, storeGet, storePresign } from './api';
import { backupDecrypt, backupEncrypt } from './crypto';
import { loadAllContacts, saveContact } from './db';
import {
    parseKeyBackupEnvelope,
    wrapKeyBackupEnvelope,
} from './key-backup-envelope';
import { fetchChain, resolveBackupKey } from './key-chain';
import { path } from './paths';

interface ContactEntry {
    user_id: string;
    handle: string;
}

interface ContactsBlob {
    v: 1;
    contacts: ContactEntry[];
}

export async function uploadContacts(
    token: string,
    userId: string,
    backupKey: CryptoKey,
    keyVersion: number,
): Promise<void> {
    const contactMap = await loadAllContacts();
    const contacts: ContactEntry[] = [];
    for (const [uid, handle] of contactMap) {
        contacts.push({ user_id: uid, handle });
    }

    const blob: ContactsBlob = { v: 1, contacts };
    const plaintext = new TextEncoder().encode(JSON.stringify(blob));

    const encrypted = await backupEncrypt(backupKey, plaintext);
    const env = wrapKeyBackupEnvelope(
        keyVersion,
        encrypted.iv,
        encrypted.ciphertext,
    );
    const blobBytes = new TextEncoder().encode(JSON.stringify(env));

    const key = path.contacts(userId);
    const { presigned_url } = await storePresign(token, key, blobBytes.length);

    await putWithRetry(presigned_url, blobBytes);
}

export async function restoreContacts(
    token: string,
    userId: string,
    backupKey: CryptoKey,
    currentVersion: number,
): Promise<number> {
    let blob: ArrayBuffer;
    try {
        blob = await storeGet(token, path.contacts(userId));
    } catch {
        // File doesn't exist (new account, first device)
        return 0;
    }

    const parsed = parseKeyBackupEnvelope(
        JSON.parse(new TextDecoder().decode(blob)),
    );

    let decryptor = backupKey;
    if (parsed.v !== currentVersion) {
        if (parsed.v > currentVersion) {
            console.warn(
                `contacts blob written under newer kv ${parsed.v} (current ${currentVersion}); skipping restore`,
            );
            return 0;
        }
        const chain = await fetchChain(token, userId);
        decryptor = await resolveBackupKey(
            userId,
            backupKey,
            currentVersion,
            parsed.v,
            chain,
        );
    }

    const plainBytes = await backupDecrypt(decryptor, {
        iv: parsed.iv,
        ciphertext: parsed.ciphertext,
    });

    const data = JSON.parse(
        new TextDecoder().decode(plainBytes),
    ) as ContactsBlob;

    let restored = 0;
    for (const contact of data.contacts) {
        await saveContact(contact.user_id, contact.handle);
        restored++;
    }

    return restored;
}
