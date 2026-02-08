# Evolution notes

This document captures likely future evolution paths of the system.
It is **not a roadmap or a commitment**.

The purpose is to preserve context, design intent, and known trade-offs,
so future changes do not require rediscovering the same discussions.

---

## Inbox storage evolution (S3)

### v0.1: Live envelopes (object-per-envelope)

- Each encrypted message envelope is stored as an immutable object.
- Objects are organized under per-user, per-device inbox prefixes.
- Clients sync by listing and fetching recent objects.
- Message identity and de-duplication are based on stable `msg_id`s.
- This model favors simplicity and correctness over optimal bulk sync performance.

Rationale:
- Minimal server-side complexity.
- No batching, compaction, or coordination required.
- Clear durability semantics (200 OK = persisted object).

---

### Potential v0.2+: Compaction into segment logs (optional)

Motivation:
- Improve full-history sync performance for new devices.
- Reduce the number of HTTP requests required for large inboxes.
- Preserve the sync-first and E2E invariants.

Conceptual approach:
- Keep a `live/` prefix for recent, un-compacted envelopes.
- Periodically compact older `live/` objects into immutable `segments/`
  (e.g. daily or time-bucketed logs).
- Compaction produces append-only segment objects; no existing objects are mutated.
- Clients syncing full history read:
  - archived `segments/` first (bulk),
  - then the `live/` tail.
- Duplicates are tolerated and eliminated client-side via `msg_id` de-duplication.

Safety properties:
- Compaction must be idempotent.
- No envelope is deleted before its contents are durably written to a segment.
- A crash during compaction may cause duplication, but not data loss.

Non-goals:
- No server-side message parsing or interpretation.
- No re-encryption or message rewriting during compaction.
- No change to the end-to-end protocol.

Open questions:
- Compaction cadence (time-based vs size-based).
- Segment granularity (per day, per hour, hybrid).
- Optional lightweight indexes (e.g. `head.json`) vs prefix scanning.

---

## Real-time delivery (optional optimization)

- v0.1 treats realtime delivery as a best-effort optimization.
- Sync from storage is the authoritative delivery mechanism.
- Future improvements may include:
  - WebSocket-based "new mail" hints,
  - cross-instance fanout via a shared pub/sub layer.

These optimizations must not become correctness dependencies.

---

## Discovery and identity (deferred)

- v0.1 uses invite-based discovery only.
- No phone numbers, email addresses, or address book access are required.

Future directions (opt-in, undecided):
- Public identifier discovery (e.g. verified phone numbers).
- Privacy-preserving contact matching.
- Additional identity claims layered on top of the existing model.

---

## Guiding principle

Evolution should favor:
- additive changes over breaking rewrites,
- client-side intelligence over server-side state,
- simple failure modes over complex coordination.

If a change requires centralized state, it must be clearly justified
and documented via an ADR.
