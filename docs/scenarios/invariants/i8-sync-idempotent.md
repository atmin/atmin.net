# I8 — Sync is idempotent

> Part of the [invariants index](./README.md). Priority **P2**.
> Spec: `web/e2e/invariants/sync-idempotent.spec.ts`.

**Statement.** Re-running sync any number of times when the cursor is
unchanged (no new remote objects since the last successful sync) does not
alter UI, Local message count, message ordering, conversation summaries,
contact list, or per-`msg_id` decryptability status.

Carve-outs: background processes that legitimately run on sync
(session-key rotation, quota recalculation) may update their own state
without violating this invariant. Only the message and conversation layers
are in scope.

**Fault construction.**

1. Alice and Bob exchange N messages; let the inbox settle (compacted into
   the archive, live drained).
2. Trigger sync on Alice K additional times. Note: `useInboxSync` is mounted
   once at the app level, so in-app navigation does **not** re-run
   `fetchMessages` — a full **page reload** does (re-mount → `syncAndPublish`).
   Each reload is a real sync pass that, thanks to the persisted cursor,
   finds nothing new.
3. Assert no change after each reload.

**Assertions.**

- `expectUI` count and order unchanged after each re-sync.
- `expectLocal` `ids` (and thus `uniqueMsgIdCount` + order) identical to the
  baseline — no duplicate row, no reordering. (Covers the conversation
  summary too, which is derived from these.)
- The inbox `live/` set stays empty and the `archive/` key set is unchanged
  — no spurious re-compaction, no objects written.
- Background `keys/` writes (session-key backup/rotation on restore) are
  carved out and not asserted.

**Permitted divergence.** None.
