# I11 — A new session never inherits a prior account's local state

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/no-cross-account-leak.spec.ts`.

**Statement.** Local persisted state (IndexedDB: messages, conversations,
Megolm sessions, and the `keys` store) belongs to exactly **one** account at a
time. Establishing a session for a *different* account on the same browser wipes
the prior account's data before any of the new account's data is written — so a
freshly authenticated account can read no message, no conversation, and **no
private key** of the account that used the browser before it.

This holds without an explicit logout in between. Logout already wipes
(`clearSession()` → `deleteDatabase()`); the gap was that **login and
registration did not**, while the shared `'atmin'` DB and the unscoped `keys`
store (`sharingPrivateKey`/`backupKey` under fixed names) meant a new account
would otherwise inherit whatever lingered. The wipe is keyed on an owner
*change* — re-authenticating as the **same** account (re-login, in-place key
rotation) keeps the cache, so it costs no needless re-sync.

**Fault construction.**

- Register account **A**; save a self-note under Saved Messages so A's local
  store is non-empty (and a `self:{A}` conversation exists).
- Inject the leak precondition — *stale local data with no active session*: drop
  only `atmin:token` from localStorage. `loadSession()` then returns null (the
  auth screens become reachable) while the owner marker `atmin:userId` stays =
  A, so the next registration is a genuine account **change**, not a fresh
  browser.
- Register account **B** in the same browser context, with no logout.

**Assertions.**

- **Local.** After B registers, A's `self:{A}` conversation holds **0**
  messages (the DB was wiped and recreated); B's own store is clean.
- **UI.** A's note text never renders for B; B's Saved Messages is empty.
- **Identity.** `atmin:userId` is now B (≠ A); B's session loads with B's own
  keys (the wipe ran *before* B's keys were written, so no A key survives).

**Permitted divergence.** None. The wipe is synchronous within `saveSession`
(awaited before any write), so there is no window in which B's session coexists
with A's data.

**Remote.** Not applicable — this is a local-cache isolation property. B's S3
state is its own freshly-registered account; A's remote data is untouched
(deleting local state never deletes remote objects — history re-syncs from S3 on
a same-account re-login).
