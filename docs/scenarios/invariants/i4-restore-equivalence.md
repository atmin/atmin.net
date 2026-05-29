# I4 — Restore-equivalence across devices

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: _not yet implemented._

**Statement.** Given the same handle and password, a second device
that comes online later converges to the same ordered message set and the
same decryptability status per `msg_id` as the first device. Convergence
is reached without manual intervention.

**Fault construction.**

1. Alice (device 1) chats with Bob; accumulate ≥1 compacted archive.
2. Alice adds device 2 *after* archives exist.
3. Device 2 completes initial sync; both devices receive a new live
   message.

**Assertions.**

- Both devices hold the same ordered `msg_id` list per conversation
  (`expectLocal` on both pages).
- Both devices can decrypt every message (decryptability status matches
  per `msg_id`).
- `expectUI(device1) === expectUI(device2)` on the same route.
- Both devices receive the post-restore live message; `expectRemote`
  shows one live object addressed to Alice's inbox.

**Permitted divergence.** Device 2's IDB may lag during the initial
backfill. Window is bounded by `GET /v1/store/list` duration; after that,
no divergence permitted.
