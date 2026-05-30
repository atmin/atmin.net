# I4 — Restore-equivalence across devices

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/restore-equivalence.spec.ts`.

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
- Both devices can decrypt every message — asserted by both rendering the
  identical message texts (a message that failed to decrypt on one device
  but not the other would break the equality).
- `expectUI(device1)` texts === `expectUI(device2)` texts on the same route.
- The post-join live message reaches **both** devices, and the two devices
  still hold the identical ordered `msg_id` list afterwards. (A precise
  "one live object in Alice's inbox" Remote assertion is intentionally
  omitted: either device's sync compacts the live object into the archive,
  so its location is timing-dependent — the cross-device convergence is the
  load-bearing assertion.)

**Permitted divergence.** Device 2's IDB may lag during the initial
backfill. Window is bounded by `GET /v1/store/list` duration; after that,
no divergence permitted.
