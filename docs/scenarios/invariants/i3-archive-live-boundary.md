# I3 — Archive/live boundary is consistent

> Part of the [invariants index](./README.md). Priority **P0**.
> Spec: _not yet implemented._

**Statement.** During and after compaction, every message is reachable
through exactly one path. No message is double-counted (live + archive),
no message is dropped at the boundary. Re-running sync after compaction
is idempotent: it produces no additional writes and does not change
message count or order.

**Fault construction.**

1. Generate enough messages to trigger one compaction.
2. Interleave a fresh device sync with an in-progress compaction.
3. Assert the new device sees every message exactly once.
4. Trigger sync again on the new device (no new messages sent); assert
   no change.

**Assertions.**

- `expectRemote(s3, uid, { liveCount: N, archiveCount: M })` where
  `N + M` equals total messages sent.
- `expectLocal(newDevice, convId, { uniqueMsgIdCount: N + M })`
- No `msg_id` appears in both `inbox/{uid}/live/` and any
  `inbox/{uid}/archive/` object (post-compaction).
- After a second sync pass: counts and order unchanged at all layers.

**Permitted divergence.** Mid-compaction, Remote may briefly hold a
message in both live and archive (until the live object is deleted).
Client-side dedup must absorb this; UI and Local must not reflect the
duplicate.
