# I8 — Sync is idempotent

> Part of the [invariants index](./README.md). Priority **P2**.
> Spec: _not yet implemented._

**Statement.** Re-running sync any number of times when the cursor is
unchanged (no new remote objects since the last successful sync) does not
alter UI, Local message count, message ordering, conversation summaries,
contact list, or per-`msg_id` decryptability status.

Carve-outs: background processes that legitimately run on sync
(session-key rotation, quota recalculation) may update their own state
without violating this invariant. Only the message and conversation layers
are in scope.

**Fault construction.**

1. Alice and Bob exchange N messages; all syncs settle.
2. Trigger sync on Alice's page K additional times (navigate away and
   back, or call the sync hook directly via `page.evaluate`).
3. Assert no change after each additional sync.

**Assertions.**

- `expectUI` count and order unchanged after each additional sync.
- `expectLocal` `uniqueMsgIdCount` and `orderedMonotonically` unchanged.
- `expectRemote` live and archive key sets unchanged (no new compaction
  triggered, no objects written).
- Conversation summary (last message, count) unchanged.

**Permitted divergence.** None.
