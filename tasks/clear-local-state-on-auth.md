# Clear local IndexedDB on auth entry — no cross-account leakage

> Captured from a live observation: a **freshly registered** account showed
> stale "Saved messages" (self-chat) items from a prior session; logging out was
> the only way to clear them. **This must never happen.** Fixed by wiping local
> state whenever the account being persisted differs from the one on disk.

## Current (grounded)

- Single shared IndexedDB named `'atmin'`, **not** per-account
  ([web/src/lib/db.ts](../web/src/lib/db.ts) `DB_NAME`).
- **Logout was safe**: `clearSession()` → `deleteDatabase()` wipes the whole DB
  ([web/src/lib/auth.ts](../web/src/lib/auth.ts)).
- **Login/registration were NOT**: both only called `saveSession()` *after*
  receiving credentials ([useLogin.ts](../web/src/hooks/useLogin.ts),
  [useRegister.ts](../web/src/hooks/useRegister.ts)); neither cleared the DB on
  entry. So any data left by a previous account on the same browser persisted
  into the new one — the stale "Saved messages", and (worse) the unscoped
  `keys`-store `sharingPrivateKey`/`backupKey` bleeding across accounts.

## Decision — model (c), wipe-on-owner-mismatch

Not (a) always-wipe (re-syncs every login) nor (b) per-account DB scoping (a
schema migration). Instead: **wipe only when the account *changes*.**
`saveSession()` now calls `wipeIfAccountChanged(userId)` first — if the stored
`atmin:userId` ≠ the incoming one (a null owner counts as a mismatch), it
`deleteDatabase()` before writing. Same-account re-auth (re-login, in-place key
rotation) keeps the cache → no needless re-sync. It's the single chokepoint all
three `saveSession` callers (login, register, rotate-keys) flow through, so the
guard can't be bypassed.

**Key-scoping is subsumed.** With mismatch-wipe, the whole DB — including the
`keys` store — is gone before a different account writes its keys, so the
HIGH-severity key leak is closed *without* per-user key scoping or a DB version
bump. Recorded here deliberately: we chose the wipe over scoping.

## Done

1. ✅ `wipeIfAccountChanged` in [auth.ts](../web/src/lib/auth.ts), called at the
   top of `saveSession`.
2. ✅ Unit tests ([auth.test.ts](../web/src/lib/auth.test.ts)): cross-account
   save wipes the prior account's cached messages + keys; same-account save
   preserves the cache.
3. ✅ Invariant **I11** + e2e: `docs/scenarios/invariants/i11-no-cross-account-local-leak.md`
   and `web/e2e/invariants/no-cross-account-leak.spec.ts`.
4. ✅ "Other cases" audited — all covered: device revocation / forced logout
   (`key_version` stale) and account deletion already route through
   `clearSession()` (full wipe); key rotation is same-user (no wipe, correct);
   an interrupted register that never reached `saveSession` leaves nothing
   persisted, and the next real auth entry wipes on mismatch.

## Verify

- `make lint test` + `pnpm tsc` green (done).
- `make e2e-local SPEC=no-cross-account-leak` (run by hand — don't collide with
  a live dev server) → passes pre-fix-fails / post-fix-passes.
- Reproduce the original manual flow on a real browser → a fresh account starts
  clean. ([user_bar_for_done] — real-device feel, not just tests-green.)

## Follow-on

Session *lifetime* (the "remember me" idea) is a separate, larger concern split
into **[remember-me-session-expiry](remember-me-session-expiry.md)** — it needs
an ADR (the token never expires server-side, so client expiry is UX, not token
invalidation).
