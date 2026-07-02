# I16 — Rotation resolves exactly once under ambiguous failure

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/rotation-idempotent-replay.spec.ts` — not yet written.

**Statement.** A `POST /v1/rotate-keys` whose response is lost (committed
server-side, 5xx or dropped connection seen client-side) leaves the account
in exactly one new era, however the client proceeds:

- `key_version` is bumped exactly once and `key_chain.json` gains exactly one
  link — never a fork, never two bumps for one intent;
- exactly one password authenticates a fresh device afterwards — the new one;
- the rotating device either converges transparently or fails *legibly* into
  re-auth, where the new password works — never a silent wedge or an
  infinite retry;
- a second deliberate rotation attempt afterwards (fresh `request_id`, stale
  `key_version`) is rejected `409`, not double-applied.

Rotation is the most dangerous state machine in the system — its failure mode
is account lockout — and its ambiguous-failure path is currently trusted on a
handler unit test (`rotate_is_idempotent_on_request_id`), never driven from a
real client.

**Fault construction — the deterministic single-device retry.** This is the
clean reproducer, and it doubles as the regression guard for a confirmed
history-loss bug (below). Account at `key_version = 3`, chain
`[{1→2}, {2→3}]`. The client changes password:
`useRotateKeys` appends a fresh chain link `{3→4}` (wrapping the old key
under a new salt-derived `K4a`) to `key_chain.json` **before** POSTing
`/v1/rotate-keys` (`web/src/hooks/useRotateKeys.ts:126-151`). Fail that first
POST transiently (`route.fetch()` to commit nothing, then
`route.fulfill({ status: 502 })` — or simply abort it before it reaches the
server). The user re-submits: a **new** salt yields a different `K4b`, a
**second** `{3→4}` link is appended after the first, and this POST commits
(server → v4, device holds `K4b`).

The bug this catches: `resolveBackupKey` selects the link with
`chain.links.find(l => l.to === 4 && l.from === 3)`
(`web/src/lib/key-chain.ts:157`) — first by array order, *not* first that
decrypts — so it returns the `K4a` link, tries to AES-GCM-decrypt it with
`K4b`, the tag fails, and it **throws**. The correct `K4b` link is never
tried. Every `v ≤ 3` session key and `contacts.json` becomes undecryptable on
every device. So the fork is not benign: a colliding orphan link sits
directly on the walk path and shadows the real one.

**Replay reachability is settled — the record is unreachable by the web
client.** `useRotateKeys` mints a fresh `request_id` on every submit
(`randomUUID()`, `useRotateKeys.ts:138`), so the server's idempotency record
(`server/src/idempotency.rs`, 24 h TTL) is never hit by a retry — the replay
path is dead code for this client. A user-driven retry is a *new* rotation
against a now-stale `key_version`; the pre-rotation profile read 401s
(`key_version_stale`) and the client logs out into legible re-auth, where the
new password works and the chain walk restores history. The spec pins that
observed path — logout-then-recover — and does **not** assert record replay.

**Assertions.**

- **Load-bearing — no fork:** after the retry commits, `key_chain.json` holds
  **exactly one** `{from: old, to: old + 1}` link, and profile `key_version`
  = old + 1. Two colliding links is the confirmed brick-history bug; this is
  the assertion that catches it.
- Fresh device: the new password restores full history *including every
  `v ≤ old` era* (the chain walk of [I9](./i9-chain-walker.md) succeeds); the
  old password fails at login.
- The rotating device ends usable — still in session, or after one legible
  re-auth prompt. No uncaught errors, no retry loop.
- A deliberate second rotation with a fresh `request_id` and the stale
  `key_version` is rejected `409 key_version_stale` and changes nothing.

**The fix this guards.** Any of: dedup by `(from, to)` in `appendChainLink`;
append the link only *after* the POST commits; or — the robust one, shared
with [I15](./i15-decryptability-closure.md) — have `resolveBackupKey` try
*every* matching link and accept the first that AES-GCM-decrypts (the tag
authenticates the right link), throwing "missing link" only if none does.

**Permitted divergence.** The rotating device's Local session may be stale
(old token, old-era keys) until its next request 401s into re-auth — bounded
and legible. No divergence at Remote at any point.
