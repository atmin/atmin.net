# I15 — Decryptability closure: every envelope has a reachable key

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/decryptability-closure.spec.ts` — not yet written.

**Statement.** For every message envelope in `inbox/{uid}/` (live or
archive), the Megolm session key that decrypts it is eventually recoverable
from `keys/{uid}/` — a live blob, an archived bundle entry, or a chain-walk
away (`key_chain.json`, [I9](./i9-chain-walker.md)) — by any device holding
the current credential. A key backup that fails does not break the closure:
it is queued in IndexedDB and re-attempted on later syncs (the
[I10](./i10-key-backup-object-name-safe.md) retry queue), and once a drain
succeeds the closure holds again. No message is ever permanently
undecryptable to its own account.

This is I10's permitted-divergence window promoted to a tested property: the
queue exists and is flushed on sync (`listPendingKeyBackups` in
`web/src/lib/messaging.ts`), but no test yet forces backups to fail for a
whole stretch of conversation, drains the queue, and proves a fresh device
recovers everything.

**Fault construction — two independent ways the closure breaks.**

_A. Backup PUTs fail for a stretch of conversation (the queue-drain path)._

1. Alice and Bob converse normally. Then fail every PUT to the storage host
   whose path contains `/keys/` (route interception on the presigned upload,
   not on `/v1/store/presign` — presign succeeds, storage rejects). More
   messages flow, including on a *fresh outbound session* (session rotation
   on app restart guarantees one), so at least one session's backup can exist
   only in the queue.
2. Live delivery continues throughout — the SSE path needs no backup.
3. Lift the fault and reload: the mount sync flushes the pending queue.
4. A clean-IDB device logs in and restores.

_B. The key exists but the chain walker can't reach it._ A confirmed bug
breaks the closure with the backup safely in S3: after a rotation retry
leaves two colliding `{from, to}` links in `key_chain.json` (the
[I16](./i16-rotation-idempotent-replay.md) fork), `resolveBackupKey`'s
`chain.links.find(...)` (`web/src/lib/key-chain.ts:157`) returns the first
matching link and throws when it fails to decrypt — never trying the second,
correct one. Construct the fork per I16, then assert a fresh device *still*
recovers every pre-rotation era: the walker must try links until one
decrypts, not throw on the first. (I16 guards against *creating* the fork;
this guards the walker being *robust* to one.)

**Assertions.**

- During the fault: sends succeed and the recipient's live view is
  unaffected; Local holds a non-empty pending-backup queue.
- Remote closure after the drain: the set of `session_id`s referenced by the
  envelopes under `inbox/{uid}/{live,archive}/` is a subset of the
  `session_id`s recoverable from `keys/{uid}/{live,archive}/` bodies (both
  sides read directly from S3; key envelopes carry the raw `session_id` in
  the body — I10).
- Fresh device (path A): every message text renders (`expectUI`), with none
  of the restore-warning states of
  [I6](./i6-bad-credential-corrupt-backup.md).
- Fresh device (path B): with a colliding chain link present, every
  pre-rotation-era message still renders — the walker found the link that
  decrypts rather than throwing on the first match.

**Permitted divergence.** While the fault holds, and until the first
successful sync after it lifts, Remote `keys/` may lack sessions Local
already has — exactly I10's queue window, never silent (each failure is
recorded). A fresh device joining *inside* the window may legitimately miss
those conversations — and says so, per I6. After the drain, no divergence at
any layer.
