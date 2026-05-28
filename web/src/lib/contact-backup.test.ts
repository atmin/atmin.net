import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installFetchMock, stored, uninstallFetchMock } from './api.mock';
import { deriveKeys, generateBackupSecret } from './crypto';
import { deleteDatabase, getContact, loadAllContacts, saveContact } from './db';

vi.mock('./api', async () => {
    const { makeApiMock } = await import('./api.mock');
    return makeApiMock();
});

beforeEach(() => {
    globalThis.indexedDB = new IDBFactory();
    globalThis.IDBKeyRange = FakeIDBKeyRange;
    stored.clear();
    installFetchMock();
});

afterEach(async () => {
    await deleteDatabase();
    uninstallFetchMock();
});

describe('uploadContacts retry', () => {
    const token = 'test-token';
    const userId = 'U_ALICE';

    async function makeBackupKey() {
        return (await deriveKeys(generateBackupSecret())).backupKey;
    }

    it('retries PUT once on 503 then resolves', async () => {
        const backupKey = await makeBackupKey();
        const { uploadContacts } = await import('./contact-backup');

        let putCalls = 0;
        globalThis.fetch = vi.fn(async (_url, init) => {
            if ((init as RequestInit)?.method === 'PUT') {
                putCalls++;
                return new Response(null, {
                    status: putCalls < 2 ? 503 : 200,
                });
            }
            return new Response(null, { status: 200 });
        }) as typeof fetch;

        await uploadContacts(token, userId, backupKey, 1);
        expect(putCalls).toBe(2);
    });

    it('rejects when PUT returns 503 twice', async () => {
        const backupKey = await makeBackupKey();
        const { uploadContacts } = await import('./contact-backup');

        globalThis.fetch = vi.fn(
            async () => new Response(null, { status: 503 }),
        ) as typeof fetch;

        await expect(
            uploadContacts(token, userId, backupKey, 1),
        ).rejects.toThrow();
    });
});

describe('contact-backup', () => {
    const token = 'test-token';
    const userId = 'U_ALICE';

    async function makeBackupKey() {
        const keys = await deriveKeys(generateBackupSecret());
        return keys.backupKey;
    }

    it('round-trips contacts through encrypt/upload → download/decrypt', async () => {
        const backupKey = await makeBackupKey();
        const { uploadContacts, restoreContacts } = await import(
            './contact-backup'
        );

        // Populate local contacts
        await saveContact('U_BOB', 'cool-badger');
        await saveContact('U_CAROL', 'swift-fox');

        // Upload
        await uploadContacts(token, userId, backupKey, 1);
        expect(stored.has(`users/${userId}/contacts.json`)).toBe(true);

        // Clear local DB to simulate new device
        await deleteDatabase();
        globalThis.indexedDB = new IDBFactory();

        // Restore
        const count = await restoreContacts(token, userId, backupKey, 1);
        expect(count).toBe(2);

        const contacts = await loadAllContacts();
        expect(contacts.get('U_BOB')).toBe('cool-badger');
        expect(contacts.get('U_CAROL')).toBe('swift-fox');
    });

    it('uploads empty contacts blob when no contacts exist', async () => {
        const backupKey = await makeBackupKey();
        const { uploadContacts, restoreContacts } = await import(
            './contact-backup'
        );

        await uploadContacts(token, userId, backupKey, 1);
        expect(stored.has(`users/${userId}/contacts.json`)).toBe(true);

        const count = await restoreContacts(token, userId, backupKey, 1);
        expect(count).toBe(0);
    });

    it('returns 0 when contacts file does not exist (404)', async () => {
        const backupKey = await makeBackupKey();
        const { restoreContacts } = await import('./contact-backup');

        const count = await restoreContacts(token, userId, backupKey, 1);
        expect(count).toBe(0);
    });

    it('restore is idempotent — calling twice does not duplicate', async () => {
        const backupKey = await makeBackupKey();
        const { uploadContacts, restoreContacts } = await import(
            './contact-backup'
        );

        await saveContact('U_BOB', 'cool-badger');
        await uploadContacts(token, userId, backupKey, 1);

        await restoreContacts(token, userId, backupKey, 1);
        await restoreContacts(token, userId, backupKey, 1);

        const contacts = await loadAllContacts();
        expect(contacts.size).toBe(1);
        expect(contacts.get('U_BOB')).toBe('cool-badger');
    });

    it('wrong backup key cannot decrypt contacts', async () => {
        const key1 = await makeBackupKey();
        const key2 = await makeBackupKey();
        const { uploadContacts, restoreContacts } = await import(
            './contact-backup'
        );

        await saveContact('U_BOB', 'cool-badger');
        await uploadContacts(token, userId, key1, 1);

        await expect(restoreContacts(token, userId, key2, 1)).rejects.toThrow();
    });

    it('restores contacts saved by a different device', async () => {
        const backupKey = await makeBackupKey();
        const { uploadContacts, restoreContacts } = await import(
            './contact-backup'
        );

        // Device A saves contacts
        await saveContact('U_BOB', 'cool-badger');
        await saveContact('U_DAVE', 'lazy-panda');
        await uploadContacts(token, userId, backupKey, 1);

        // Device B: fresh DB
        await deleteDatabase();
        globalThis.indexedDB = new IDBFactory();

        const count = await restoreContacts(token, userId, backupKey, 1);
        expect(count).toBe(2);

        expect(await getContact('U_BOB')).toBe('cool-badger');
        expect(await getContact('U_DAVE')).toBe('lazy-panda');
    });
});

describe('chain-aware restoreContacts (post-rotation)', () => {
    const token = 'test-token';
    const userId = 'U_ROT';

    it('walks the chain to decrypt a v1 contacts blob under a v2 account', async () => {
        const { uploadContacts, restoreContacts } = await import(
            './contact-backup'
        );
        const { buildChainLink, appendChainLink } = await import('./key-chain');

        const v1Key = (
            await deriveKeys(generateBackupSecret(), { extractable: true })
        ).backupKey;
        const v2Key = (
            await deriveKeys(generateBackupSecret(), { extractable: true })
        ).backupKey;

        // Seed contacts and write them under v1.
        await saveContact('U_BOB', 'cool-badger');
        await saveContact('U_DAVE', 'lazy-panda');
        await uploadContacts(token, userId, v1Key, 1);

        // Account rotates to v2; chain link published.
        await appendChainLink(
            token,
            userId,
            await buildChainLink(1, 2, v1Key, v2Key),
        );

        // Fresh device at v2: restore must walk the chain to decrypt the v1 blob.
        await deleteDatabase();
        globalThis.indexedDB = new IDBFactory();
        const count = await restoreContacts(token, userId, v2Key, 2);
        expect(count).toBe(2);
        expect(await getContact('U_BOB')).toBe('cool-badger');
        expect(await getContact('U_DAVE')).toBe('lazy-panda');
    });

    it('refuses to restore a contacts blob written under a newer kv than current', async () => {
        const { uploadContacts, restoreContacts } = await import(
            './contact-backup'
        );

        const v1Key = (
            await deriveKeys(generateBackupSecret(), { extractable: true })
        ).backupKey;
        const v2Key = (
            await deriveKeys(generateBackupSecret(), { extractable: true })
        ).backupKey;

        await saveContact('U_BOB', 'cool-badger');
        await uploadContacts(token, userId, v2Key, 2);

        await deleteDatabase();
        globalThis.indexedDB = new IDBFactory();
        // Restore at currentVersion=1 — blob is v2, walker refuses.
        const count = await restoreContacts(token, userId, v1Key, 1);
        expect(count).toBe(0);
    });
});
