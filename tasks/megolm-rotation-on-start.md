# Rotate Megolm session on app start

## Spec
`docs/specs/mvp-v0.1.md` line ~151: "A new session is created on app start and rotated after 100 messages, whichever comes first."

## Current
`web/src/lib/megolm-session.ts` `createSessionManager()` loads an existing outbound session from IndexedDB and reuses it. No rotation happens on app start — only after 100 messages via `needsRotation()`.

## Change
1. In `web/src/lib/megolm-session.ts` `createSessionManager()`: after loading a stored session, always create a fresh outbound session instead of reusing it. The old session's inbound side is kept for decryption.
2. The new session must be backed up and key-shared to active contacts (see `sendMessage` flow in `api.ts` which already handles `isNewSession`).
3. Update `web/src/lib/megolm-session.test.ts` — the "persists and restores across manager instances" test currently asserts session reuse. Update to verify a new session ID is created on the second manager instance.

## Verify
- `cd web && npm test` passes (updated test asserts new session ID on re-init)
- `make e2e` passes
