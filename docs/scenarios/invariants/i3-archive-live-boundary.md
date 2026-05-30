# I3 — Archive/live boundary is consistent

> Part of the [invariants index](./README.md). Priority **P0**.
> Spec: `web/e2e/invariants/archive-live-boundary.spec.ts`.

**Statement.** After compaction, every message is reachable through
exactly one path: no `msg_id` lives in both `inbox/{uid}/live/` and an
`inbox/{uid}/archive/` bundle, nothing is dropped at the boundary, and a
fresh device reconstructs the complete set exactly once and in order.
Re-syncing with no new messages changes nothing.

**Fault construction.** Compaction is a single server operation
(`POST /v1/store/compact` writes the archive bundle, then deletes the
live objects), so the literal "sync during an *in-progress* compaction"
window is server-internal and can't be observed from the client. The
spec instead reproduces both halves directly:

1. _Boundary._ Bob sends a batch; Alice's sync compacts it into the
   archive (poll until `archive/` is non-empty and `live/` has drained).
   Close Alice's client so a second batch stays in `live/`, post-boundary.
   Now both prefixes are populated.
2. _Overlap (the transient state compaction holds only briefly)._ With
   the client frozen, put an archived message envelope back into `live/`
   so the same `msg_id` exists in both prefixes, and let a fresh device
   sync it.

**Assertions.**

- _Boundary:_ the `msg_id` sets of `live/` and `archive/` are disjoint.
- _Completeness + order:_ a fresh device shows every message exactly once
  (`expectUI` count + texts) and `expectLocal` has the same unique count,
  monotonic by ULID.
- _Idempotent re-sync:_ a second sync with no new messages leaves UI and
  Local count/order unchanged.
- _Overlap:_ with a `msg_id` deliberately in both prefixes, the fresh
  device shows it once — `fetchMessages` syncs live first, seeds
  `seenMsgIds`, and `syncArchive` skips already-seen ids (live-first dedup).

**Permitted divergence.** Mid-compaction, Remote may briefly hold a
message in both live and archive (until the live object is deleted).
Client-side dedup must absorb this; UI and Local must not reflect the
duplicate.
