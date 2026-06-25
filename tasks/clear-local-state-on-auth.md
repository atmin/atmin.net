# Clear local IndexedDB on auth entry — no cross-account leakage

> Captured from a live observation: a **freshly registered** account showed
> stale "Saved messages" (self-chat) items from a prior session; logging out was
> the only way to clear them. **This must never happen.** On login *and*
> registration we must clear local state — and likely scope it per-account.

## Current (grounded)

- Single shared IndexedDB named `'atmin'`, **not** per-account
  ([web/src/lib/db.ts](../web/src/lib/db.ts) `DB_NAME`).
- **Logout is safe**: `clearSession()` → `deleteDatabase()` wipes the whole DB
  ([web/src/lib/auth.ts](../web/src/lib/auth.ts)).
- **Login/registration are NOT**: both only call `saveSession()` *after*
  receiving credentials ([useLogin.ts](../web/src/hooks/useLogin.ts),
  [useRegister.ts](../web/src/hooks/useRegister.ts)); neither clears the DB on
  entry. So any data left by a previous account/session on the same browser
  persists into the new one — exactly the stale "Saved messages" seen.
- Messages *are* user-scoped (`loadMessages(userId)` filters by a
  `userId_timestamp` index, db.ts), which mitigates message bleed — but the
  conversation/self-chat list that surfaced the stale entries needs auditing for
  the same scoping.
- **HIGH — crypto keys are not user-scoped.** `sharingPrivateKey` / `backupKey`
  are stored by fixed name in the keys store (db.ts, auth.ts `putKey`), no
  `userId`. A second account on the same browser (no logout first) **overwrites
  or reads the first account's private keys** — a cross-account cryptographic
  leak, worse than the visible-message symptom.

## Change

1. **Wipe on every session-establishing entry**, not just logout. `await
   deleteDatabase()` at the *start* of both the login and registration flows,
   before `saveSession()`. History re-syncs from S3, so nothing is lost — this
   mirrors the existing logout-wipes model, making it symmetric.
2. **Decide the model** (capture in the change):
   - **(a) Always-wipe-on-auth-entry** — simple, safe, symmetric with logout.
     Recommended default.
   - **(b) Per-account scoping** — DB name or key prefix includes `userId`,
     preserving multi-account local caches. More work; the keys store *must* be
     scoped under this option. Only if multi-account local persistence is wanted.
3. **Fix the keys store regardless** — even with (a), ensure no key from a prior
   account can survive into a new session.
4. **Audit "other cases"** the original note flagged: device revocation /
   forced logout, account deletion, key rotation, and an interrupted register
   that never reached `saveSession()`.

## Invariant

Worth promoting to a fault-injection invariant
([docs/scenarios/invariants/](../docs/scenarios/invariants/)): *a newly
authenticated session never exposes a prior account's local data — messages,
self-chat, or keys.* New `i{N}-…` file + a Playwright invariant spec.

## Verify

- E2E: register account A on a fresh context, post a self "Saved messages" note;
  then register/login account B **in the same browser context without an
  explicit logout**. Assert B's conversation list is empty, B reads no A
  messages, and B's keys are its own (not A's).
- Reproduce the original manual flow on a real browser → fresh account starts
  clean.
- `make lint test` + the new invariant spec pass.
