# I6 — Bad credential / corrupt backup fails legibly

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/bad-backup-secret.spec.ts`.

**Statement.** The two failure modes are distinct, and neither is silent:

- A **wrong password** is rejected at login — no session is established,
  no local session state is written.
- A **correct password against a corrupt/undecryptable key-backup blob**
  does *not* block login. Restore is resilient: it recovers every blob it
  can, counts the ones it cannot, and surfaces that count to the user
  ("N conversations' history couldn't be restored"). One bad blob must
  not cost the user every *other* conversation — but the loss is shown,
  not swallowed.

**Fault construction.**

- *Wrong secret*: register Alice, then attempt second-device login with
  a different password.
- *Corrupt ciphertext*: register Alice and receive ≥1 message (so a
  key-backup blob exists), then on a fresh device corrupt that
  `keys/{uid}/live/{session_id}` blob's ciphertext before logging in with
  the *correct* password.

**Assertions.**

- *Wrong secret*: login does not succeed (stays on `/login` with an
  error); no session token is persisted; IDB holds no restored session.
- *Corrupt blob*: login succeeds; the restore-warning signal
  (`[data-testid="restore-warning"]`) appears with the failed count; the
  client does not crash; conversations whose blobs were intact still
  restore.
- Remote state is unchanged in both cases (the fault is read-side).

**Permitted divergence.** A corrupt blob is skipped, not repaired — that
conversation's history stays absent on this device until a good copy is
restored. The user is told; it is not silent.
