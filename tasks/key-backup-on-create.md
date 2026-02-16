# Write key backup when session is created, not only on first send

## Spec
`docs/specs/mvp-v0.1.md` line ~152: "Rotation triggers a key backup write, key shares to active contacts."

## Current
`web/src/lib/api.ts` `sendMessage()` (~line 198) only writes the backup when `isNewSession` is true during a send. A session created at app start (or after rotation-on-start) is not backed up until the first message is sent. Multi-device recovery gap: if the user never sends, the session key is lost.

## Change
1. Move the key backup write into session creation itself. In `web/src/lib/megolm-session.ts`, after creating a new outbound session (both initial and rotation), call `backupSessionKey()`.
2. This requires `backupSessionKey` (from `key-backup.ts`) to be callable from the session manager — pass `token`, `userId`, and `backupKey` into `createSessionManager()` or provide a callback.
3. Remove the backup logic from `api.ts` `sendMessage()` since it's now handled at creation time.

## Verify
- `cd web && npm test` passes
- `make e2e` passes
- Manual: create a second device, verify it can restore the session key even if the first device never sent a message
