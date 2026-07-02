# Live-sync cursor robustness

> **Audit findings:** M8, L7 · **Priority: Medium.**

## Why it matters

- **M8 — a below-cursor live message is stranded.** `syncLive` uses an exclusive
  high-water cursor ([messaging.ts:373-411](../web/src/lib/messaging.ts)); the
  server returns only keys `> cursor`. `msg_id` is a **sender-minted,
  non-monotonic ULID** with a wall-clock prefix, and every DM has ≥2 clock
  sources writing the recipient's inbox (the peer + the recipient's own
  self-copies). A message whose ULID sorts *below* the persisted cursor is never
  listed → `lastKey` undefined → `triggerCompaction` never fires → it stays in
  `live/` forever (never archived), and `syncArchive` (archive-prefix only)
  can't see it. It surfaces only when later higher-ULID traffic arrives and
  sweeps it into the archive. No permanent loss, but indefinite if it's the last
  traffic before a quiet period. An I2 edge the invariant doesn't cover.
- **L7 — `messageCount` inflates on the no-cursor fallback.** `syncLive` passes a
  **fresh empty** dedup set to `processEnvelopes`, unlike `syncArchive` (seeded
  from `loadMessageIds`). If a cursor-scoped list *throws* (transient 5xx),
  `syncLive` falls back to a full live re-list and re-decrypts/re-counts
  still-live messages; rows stay idempotent by id, but
  `StoredConversation.messageCount` drifts upward by the batch size each time —
  an I8 "Permitted divergence. None." violation. Latent today (`messageCount` is
  rendered only in a Storybook file).

## Current

Exclusive high-water cursor for the live prefix; empty dedup set in `syncLive`.

## Change

1. Drop the exclusive cursor for the **live** prefix: full-list
   `inbox/{uid}/live/` and dedup by `msg_id` (mirroring `syncArchive` — live is
   small and compaction-bounded). Alternatively, trigger compaction whenever the
   live prefix is non-empty.
2. Seed `syncLive`'s dedup set from `loadMessageIds` (like `syncArchive`),
   and/or make `saveMessages` count only newly-inserted rows.

## Verify

- Add an [i2](../docs/scenarios/invariants/i2-no-lost-messages.md) case: write a
  below-cursor live key and assert it materializes **without** newer traffic.
- Extend [i8](../docs/scenarios/invariants/i8-sync-idempotent.md): a list-failure
  fallback does not inflate `messageCount`.
