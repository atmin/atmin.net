/**
 * Contact backup — encrypt/upload and download/decrypt the contacts list.
 *
 * Contacts are encrypted with the user's backup key (AES-256-GCM)
 * and stored at `users/{userId}/contacts.json`.
 * Last-write-wins. All devices read the same file.
 */

import { storeGet, storePresign } from './api';
import { backupDecrypt, backupEncrypt } from './crypto';
import { loadAllContacts, saveContact } from './db';
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
): Promise<void> {
    const contactMap = await loadAllContacts();
    const contacts: ContactEntry[] = [];
    for (const [uid, handle] of contactMap) {
        contacts.push({ user_id: uid, handle });
    }

    const blob: ContactsBlob = { v: 1, contacts };
    const plaintext = new TextEncoder().encode(JSON.stringify(blob));

    const encrypted = await backupEncrypt(backupKey, plaintext);
    const encryptedBlob = JSON.stringify({
        iv: btoa(String.fromCharCode(...encrypted.iv)),
        ciphertext: btoa(String.fromCharCode(...encrypted.ciphertext)),
    });
    const blobBytes = new TextEncoder().encode(encryptedBlob);

    const key = path.contacts(userId);
    const { presigned_url } = await storePresign(token, key, blobBytes.length);

    await fetch(presigned_url, {
        method: 'PUT',
        body: blobBytes,
    });
}

export async function restoreContacts(
    token: string,
    userId: string,
    backupKey: CryptoKey,
): Promise<number> {
    let blob: ArrayBuffer;
    try {
        blob = await storeGet(token, path.contacts(userId));
    } catch {
        // File doesn't exist (new account, first device)
        return 0;
    }

    const { iv, ciphertext } = JSON.parse(new TextDecoder().decode(blob));
    const ivBytes = Uint8Array.from(atob(iv), (c) => c.charCodeAt(0));
    const ctBytes = Uint8Array.from(atob(ciphertext), (c) => c.charCodeAt(0));

    const plainBytes = await backupDecrypt(backupKey, {
        iv: ivBytes,
        ciphertext: ctBytes,
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
