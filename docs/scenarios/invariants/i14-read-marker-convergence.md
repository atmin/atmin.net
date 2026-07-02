# I14 — Read markers converge and never resurrect "New"

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/read-marker-convergence.spec.ts` — not yet written.

**Statement.** Per-conversation read watermarks (ADR-0026) only ever advance.
Any interleaving of reads, debounced uploads, and syncs across N devices
converges — after each device's next sync — to the per-conversation `max()`,
and a conversation read anywhere is never resurrected as unread anywhere:
no chats-row badge, no `── New ──` divider, no app-icon count, once converged.

The merge itself is a CRDT join with unit-tested laws
(`web/src/lib/read-markers.ts`). What only an e2e can pin is the blob's
read-modify-write window: `syncReadMarkers` GETs, merges, PUTs the whole
`read-markers.json` — two devices interleaving those steps leave the *blob*
missing one device's advance until the trailing device's next GET-merge
cycle. The UI consequence to rule out is that lost blob update
re-materializing as fake unread for a later reader (a third device, a fresh
login).

**Fault construction.**

1. _Interleaved PUT._ Alice on devices A and B, with unread in two different
   conversations. A reads chat 1; B reads chat 2. Hold A's presigned
   `read-markers.json` PUT (route the storage host, not `/v1/store/presign`)
   until B's lands, then release — each write was built on a GET that
   predates the other. Let both devices run one more sync; then log in a
   fresh device.
2. _Offline read._ B reads while offline; local state clears immediately;
   the upload flushes on reconnect and must merge into, not clobber,
   advances A made meanwhile.
3. _Future-dated sender (a confirmed poisoning, not a hypothetical)._
   `sent_at` is a sender-minted **plaintext** envelope header
   (`web/src/lib/envelope.ts`) that the reader stores verbatim as the
   message's ordering timestamp (`web/src/lib/messaging.ts:341` —
   `new Date(envelope.sent_at ?? 0)`). A modified sender stamps it far in the
   future (year 9999); the reader opens the chat, and `markConversationRead`
   pins `lastReadTimestamp` to that value. Because the merge is monotone
   `max()`, the poisoned watermark is **irreversible** and replicates to
   every current and future device via `read-markers.json` — from then on
   every honest later message has a smaller timestamp and is silently
   suppressed (no badge, no divider). ADR-0026's skew-immunity argument
   covers honest *reader* clock skew; it does not cover a malicious *sender*.
   The fix is an ingest clamp — `timestamp = min(sent_at, now + SKEW)` at
   `messaging.ts:341`, and defence-in-depth clamping `markConversationRead`'s
   input. This case **fails against current code** (no clamp exists); it is
   the regression guard that ships *with* the clamp. Construct it by driving
   a sender whose `sent_at` is forced into the future (a shifted `page.clock`
   at send time, or a route that rewrites the outgoing envelope).
4. _Racing local writers (the same-device analogue of the blob race)._ Two
   tabs sharing one IndexedDB (see [I12](./i12-concurrent-sync.md)) both call
   `markConversationRead`: each compares against a transaction snapshot, then
   writes — interleaved, one can *lower* the watermark or undercount. The
   `max()` CRDT protects the cross-device *blob* merge, not this local
   read-modify-write, so it needs its own guard.

**Assertions.**

- After the interleave settles: both devices and a fresh login agree — no
  badge (`expectUnreadBadge(page, handle, null)`) and no divider
  (`expectNewDivider(page, false)`) for either conversation.
- Local: each device's conversation rows carry the merged (max) watermark.
- Remote is asserted behaviourally: a fresh device that has only the blob to
  go on shows no unread anywhere — proving the blob carries every advance.
- Future-dated sender: after a year-9999 message is ingested and its chat is
  read, a subsequently-arriving honest message still shows a badge and
  divider (i.e. the watermark was clamped at ingest, not pinned to 9999).
- Racing local writers: after two interleaved `markConversationRead` calls,
  the local watermark equals the higher of the two, never the lower, and the
  message count is not undercounted.

**Permitted divergence.** Between a read and that device's upload landing
(debounce plus one GET-merge-PUT), other devices may still show the unread —
bounded by the trailing device's next sync. The blob may transiently lack the
losing writer's advance in the interleave; it must contain it after that
writer's next cycle. No divergence may ever *regress* a watermark, and no
sender-supplied timestamp may ever advance it past the reader's local now.
