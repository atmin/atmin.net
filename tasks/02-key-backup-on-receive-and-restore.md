# Complete the key-backup lifecycle: back up received session keys + wire restore on new device

## Spec
`docs/specs/mvp-v0.1.md` "Client sync algorithm — Normal sync" step 2:
> Process key-share envelopes first (decrypt with sharing private key, store Megolm keys). **Write newly received Megolm keys to key backup via `store/presign`.**

`docs/scenarios/account-recovery.md` step 2:
> New device sync starts with key backups (needed before any messages can be decrypted): `GET /v1/store/list?prefix=keys/{uid}/live/` … decrypt each with the backup encryption key → recovers Megolm session keys S1, S2, S3. Stores in IndexedDB.

`docs/scenarios/session-rotation.md` shows Alice (the receiver) issuing `PUT key backup (S3 received)` after receiving Bob's key share.

## Current
Two gaps:

1. **No backup on receive.** `web/src/lib/api.ts` — `processEnvelopes` decrypts inbound key shares and calls `sessionManager.addInbound(...)`, but never calls `backupSessionKey`. The function `backupSessionKey` (in `web/src/lib/key-backup.ts`) is only invoked from `web/src/hooks/useSession.ts` via the `onSessionCreated` callback, i.e. only for the local **outbound** session.

2. **Restore is dead code.** `web/src/lib/key-backup.ts` exports `restoreSessionKeys`, which fetches `keys/{uid}/live/` + `keys/{uid}/archive/` and re-imports each session into `sessionManager`. `grep -rn restoreSessionKeys web/src` shows no caller. New-device login currently relies on inbox archives still containing the original key-share envelopes — which is fragile if compaction ever drops a `keys/` archive separately, or if the inbox archive is GC'd.

The two gaps compound: even if we wired `restoreSessionKeys` in, there'd be nothing to restore for inbound sessions because they were never backed up.

## Change
1. In `web/src/lib/api.ts`, after `sessionManager.addInbound(...)` in the key-share branch of `processEnvelopes`, call `backupSessionKey(token, userId, sessionId, sessionKeyB64, backupKey)`. This requires threading `token` and `backupKey` through `processEnvelopes` → `fetchMessages` → `syncMessages` (currently they only take `userId`, `sharingPrivateKey`, `sessionManager`). Skip if the session is already known (call `sessionManager.getInbound(sessionId)` first to avoid re-uploading on every receive).
2. In `web/src/hooks/useSession.ts`, after `createSessionManager(...)` resolves and before `restoreContacts(...)`, call `restoreSessionKeys(token, userId, backupKey, mgr)`. This must run **before** the first `syncMessages` so inbound sessions are available when the inbox replay starts. Add a comment pointing at `docs/scenarios/account-recovery.md`.
3. `restoreSessionKeys` currently swallows fetch errors (`console.error`). Keep that — a missing `keys/` prefix (new account) is normal — but add a top-level try/catch around the whole call in `useSession` so a failure can't block session boot.

## Verify
- `make web-test` passes.
- New unit test in `web/src/lib/api.test.ts`: when a key-share envelope arrives, `storePresign` is called once with key `keys/{uid}/live/{sessionId}` and the PUT body decrypts back to the session key. A second arrival of the same key share is a no-op (cache hit on `getInbound`).
- New unit test or extension of `web/src/lib/megolm-session.test.ts` (or `key-backup.test.ts` — create if missing): `restoreSessionKeys` invoked on a fresh `SessionManager` with a populated `keys/{uid}/live/` re-imports the inbound sessions; subsequent `getInbound(sessionId)` returns non-null.
- Manual: register Alice + Bob, exchange a few messages, log in as Alice on a third device using only the mnemonic, observe history decrypts. Update `web/e2e/multi-device.spec.ts` if it needs to assert the new device sees the backup-restored history (it likely already does).
