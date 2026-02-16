# Sync encrypted contacts blob to S3

## Spec
`docs/decisions/adr-0005-profiles-contacts.md`: contacts stored as a single AES-256-GCM encrypted blob at `users/{uid}/contacts.json`. Plaintext: `{"v": 1, "contacts": [{user_id, handle, display_name, sharing_public_key, added_at}]}`. Encrypted with `backup_key`. Last-write-wins. All devices read the same file.

## Current
`web/src/lib/db.ts` has a local `contacts` IndexedDB store (userId→handle cache). `web/src/hooks/useConversations.ts` resolves contacts by fetching profiles. No upload/download of the encrypted blob to `users/{uid}/contacts.json`.

## Change
1. In `web/src/lib/` add contact sync functions: `encryptContacts(contacts, backupKey)` → `{iv, ciphertext}` JSON, `decryptContacts(blob, backupKey)` → contact list.
2. Upload after adding a new contact: `storePresign` + PUT to `users/{uid}/contacts.json`.
3. Download on device init (new device restore): fetch `users/{uid}/contacts.json`, decrypt, populate local IndexedDB.
4. Wire into `useConversations.ts` or a new `useContacts` hook.

## Verify
- `cd web && npm test` passes
- Manual: register on device A, chat with someone, open device B — contacts appear without re-resolving
