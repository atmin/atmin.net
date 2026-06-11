# Key backup: base64 `session_id` used raw as an S3 key → silent backup loss

**Severity: HIGH — silent data-integrity bug (undecryptable history on restore).**
Pre-existing on `master`; **parked** during the Rust cutover (ADR-0018). Plan: finish
the Rust transition, then **apply this first** — on `master`, then rebase
`rust-port-experiment` on top (the bug is backend-agnostic; it lives entirely in
`web/`, both servers are blameless).

## How it was found

`flaky-compare.sh UNTIL_FAIL SPEC=credential-rotate-ui` (the Go-vs-Rust flake hunt)
caught it on the rotation/history test, ~4% of runs, on **both** backends. The
preserved `trace.zip` showed the real cause — not timing:

```
PUT …/keys/{uid}/live//u7WXSVT5ETLqmo+zPTQy/UGmjbUvX8ZdDkAehP76VE  → 400
<Code>XMinioInvalidObjectName</Code><Message>Object name contains unsupported characters.</Message>
console: "Key backup failed: PUT failed: 400"
```

## Spec (intended)

Storage layout (`docs/specs/mvp-v0.1.md`, CLAUDE.md S3 table):
`keys/{uid}/live/{session_id}` — a per-session encrypted Megolm key backup. Implicitly
assumes `session_id` is a valid S3 object-name segment.

## Current (the bug)

[`web/src/lib/paths.ts:15`](../web/src/lib/paths.ts) interpolates the session id raw:

```ts
keyBackup: (uid, sid) => `keys/${uid}/live/${sid}`,
```

Megolm `session_id` is **standard base64** — alphabet includes `/` and `+`. When the
encoding yields a **leading / trailing / doubled `/`**, the object name is invalid →
MinIO (and S3) reject the presigned PUT with `XMinioInvalidObjectName` 400. The
backup is fire-and-forget — `backupSessionKey(...).catch(err => console.error(...))`
([`web/src/lib/messaging.ts:244`](../web/src/lib/messaging.ts)) — so the failure is
**swallowed** and that session's key is **never backed up**.

- **Rate ≈ 4%** — data-dependent (the fraction of session_ids producing `//`/leading/
  trailing slash; ~1/64 per position), *not* timing. Explains the bimodal runtimes
  (clean id → fast pass; bad id → hard fail).
- **Backend-agnostic** — the client builds the key; Go and Rust just presign what
  they're handed. Both flake identically. **Not** a Rust-port issue.
- **Impact** — silent, permanent: on any restore-from-backup path (fresh device,
  post-rotation re-login, device migration) ~4% of sessions' messages are
  undecryptable. The (~45% of) session_ids with a *single embedded* `/` currently
  succeed at a cosmetically-wrong key (`live/a/b`) and still restore (sid is read from
  the envelope body, not the key), so only the invalid-name fraction is lost.

## Change (the fix)

1. **Encode the session id path-safe before it is an S3 key segment** — reuse
   `base64UrlEncode` (already in the codebase; `-_`, no `/`/`+`/`=`):
   `keys/${uid}/live/${base64url(sid)}`. Self-contained on the *write* side **iff**
   nothing reverse-parses the sid out of the key — restore lists `keys/{uid}/live/`
   and reads `session_id` from the envelope body, so it doesn't. **Verify that grep
   before relying on it.** Apply to every place a session id becomes a key segment.
2. **Update the storage-layout spec** — `keys/{uid}/live/{session_id}` →
   `…/{base64url(session_id)}` in `docs/specs/mvp-v0.1.md` + CLAUDE.md S3 table.
3. **Stop swallowing backup failures** (defense-in-depth) — a failed key backup is
   future history loss; it deserves a retry and a surfaced warning, not a
   `.catch(console.error)`. Even with #1, this class of failure must not be silent.
4. *(Optional belt)* server-side: reject object-name-unsafe keys at `store/presign`
   so a future client bug fails loudly at the API instead of at the S3 PUT.
5. **Migration** — in the current no-prod-users world, likely none needed (failing
   keys were never written; succeeding slash keys still list + restore via the
   envelope body). If prod data ever exists, dual-read old/new key forms during a
   window. Decide at fix time.

## Verify

- `./scripts/flaky-compare.sh` with `UNTIL_FAIL=1 SPEC=credential-rotate-ui` goes from
  ~4% to **0** — the ready-made regression guard.
- **New invariant** (`docs/scenarios/invariants/`): key backups survive adversarial
  session_ids — a session id with a leading / doubled / trailing slash (and `+`) still
  backs up *and* restores. Add the row to the invariants README + a Playwright test.
- Unit test: `paths.keyBackup` yields a valid S3 object name (no `//`, no leading/
  trailing `/`) for session ids containing `/`, `+`, and a leading `/`.
