# Paginated + chunked prefix wipe

> One shared drain-loop wipe helper; chunk `delete_objects`. **Audit findings:**
> H4, H5, M7 · **Priority: High.**

## Why it matters

- **H4 — account deletion orphans data forever.** `delete_profile` lists each
  owned prefix with a single `list_objects(&prefix, 1000, None)` and deletes
  only that page — no loop ([routes.rs:812-837](../server/src/routes.rs), the
  comment even admits "single 1000-key page each"). An account past 1000 objects
  under an unbounded prefix (`keys/{uid}/` — one per Megolm session, multiplies
  across conversations/rotations; `inbox/{uid}/`) is only partially deleted.
  Because the tombstone carries an **empty `user_id`**, the retention sweep can
  never re-derive the uid to finish — E2E-encrypted key material and inbox
  envelopes persist **indefinitely**. Right-to-erasure violation + permanent
  leak. (`media/` is safe — capped at 1000.)
- **H5 — compaction wedges past 1000 live keys.** `store_compact` collects live
  keys unboundedly then passes the whole Vec to a single `store.delete_objects`
  ([routes.rs:718-720](../server/src/routes.rs)); `S3Store::delete_objects`
  ([store_s3.rs:155](../server/src/store_s3.rs)) issues one `DeleteObjects`
  request with no chunking. S3/MinIO rejects >1000 keys (400) → the whole delete
  fails → nothing removed, but the archive was already written durably → every
  later compaction re-reads the same >1000 live keys and fails again. Wedged
  compaction + storage bloat (not data loss). Triggers: a long-offline recipient,
  or inbox flooding (see [abuse-controls]).
- **M7 — cleanup mid-wipe orphan.** `cleanup::delete_user`
  ([cleanup.rs:206](../server/src/cleanup.rs)) wipes `prefix_user` (contains
  `profile.json`) first; a 5xx on a later prefix returns `Err` with the profile
  already gone → `evaluate_user` then finds handle-present/profile-NotFound →
  `Ok(None)` ("leave it") → the wipe never resumes.

## Current

`delete_profile` single-page; `S3Store::delete_objects` unchunked; **the fix
already exists**: `cleanup::delete_user` ([cleanup.rs:214-225](../server/src/cleanup.rs))
loops list+delete until drained. `MemStore::delete_objects` loops uncapped, so
handler tests pass regardless of key count.

## Change

1. `S3Store::delete_objects`: chunk into `keys.chunks(1000)`, one API call per
   chunk, aggregate errors — makes the `Store` contract safe for **all** callers
   (canonical H5 fix).
2. Factor the paginated per-prefix wipe into **one shared helper** both
   `delete_profile` and `cleanup::delete_user` call (so they can't drift again).
   `delete_profile` keeps its per-page device-cache eviction.
3. Delete ordering/resumability lives in [account-lifecycle-serialization];
   M7's reorder (data prefixes first, `users/` last) belongs there too.

## Verify

- Ships **[I18](../docs/scenarios/invariants/i18-cleanup-sweep-safety.md)**
  (expired account wiped *completely*).
- Handler test: seed >1000 objects under `inbox/{uid}/` → `DELETE /v1/profile`
  → zero remain. Compaction test feeding >1000 live keys (MemStore capped to
  expose it, or an S3-path test).
