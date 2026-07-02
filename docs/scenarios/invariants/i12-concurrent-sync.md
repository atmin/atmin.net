# I12 — Concurrent same-account clients converge

> Part of the [invariants index](./README.md). Priority **P0**.
> Spec: `web/e2e/invariants/concurrent-sync.spec.ts`.

**Statement.** Concurrent clients of one account syncing and compacting the
same inbox at the same time converge to the same exactly-once message set. No
interleaving of `GET /v1/store/list` and `POST /v1/store/compact` may lose a
message or render a duplicate. Cross-bundle archive duplication is possible by
construction — the server holds no per-uid mutex for compaction (only
handle-claim and rotation do), so two concurrent compacts can each fold the
same live objects into their own bundle — and client-side dedup must absorb it
on every future sync, including a fresh device's first.

Two devices of one account are the tractable concurrent case: separate
IndexedDBs and cursors, one shared S3 inbox, both racing the same
compaction. (A second, narrower race exists between two **tabs sharing one
IndexedDB and cursor** — `useInboxSync` mounts once per app instance precisely
because concurrent `fetchMessages` callers once raced the cursor, per the
header comment in `web/src/lib/inbox-sync.ts`. That needs a single-context
two-tab harness and is left as a follow-on.)

**Fault construction.**

1. _Two-device race._ Register Alice (device 1); log her in on device 2 (same
   account, own IDB). Both devices open the chat and stay online while Bob
   sends a burst. Whichever device's post-sync compaction fires first deletes
   the live objects out from under the other's in-flight sync — the natural
   race, no gating required.
2. _Cross-bundle duplication, deterministically._ The worst legal outcome of
   the race above is timing-dependent server-side, so it is also constructed
   by hand (the [I3](./i3-archive-live-boundary.md) move, one level up): copy
   an archived message envelope into a sibling `archive/` bundle so the same
   `msg_id` exists in two bundles, then let a fresh device sync.

**Assertions.**

- Both devices render the full burst exactly once (`expectUI` on each), and
  each device's IDB holds every `msg_id` exactly once, ordered
  (`expectLocal`).
- Remote, once settled: `live/` drains to empty; each archive bundle is
  internally duplicate-free; and the union of the bundles contains every
  `msg_id` the Local layer holds — a live object may disappear only into some
  archive bundle, never into nothing.
- Fresh device (after the two-device race, and against the hand-built
  duplication): every message exactly once, in order.

**Permitted divergence.** Remote may hold the same `msg_id` in more than one
archive bundle, permanently — the concurrent-compaction artifact
[I1](./i1-message-identity.md) already scopes (uniqueness is strict only
*within* a bundle). UI and Local stay strict everywhere.
