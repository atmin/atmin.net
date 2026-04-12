# Storage-used indicator in settings

## Status

Sketch — needs planning before implementation. Depends on media upload
([tasks/media-upload.md](./media-upload.md)) having landed so
`media/{uid}/` exists and the quota cache is populated.

## Motivation

v0.1 ships without media GC. Orphan blobs and legitimate attachments
both count against the 1 GiB quota until account deletion. Without a
visible "storage used" figure, users have no way to notice pressure or
act on it (re-uploading a smaller file, deleting the account as a last
resort).

A minimal indicator gets ~80% of the value of shipping GC, for a
fraction of the effort, and is a useful building block for GC's UX
later (the same endpoint can show "X MB reclaimable").

## Sketch

Server:

- New endpoint `GET /v1/storage/usage` → `{ "used_bytes": ..., "quota_bytes": ..., "blob_count": ..., "quota_blob_cap": ... }`.
- Backed by the same `MediaQuotaStore.ReserveUpload` path's cache; a
  read-only `GetUsage(uid)` method refreshes from `ListObjectsV2` if
  the cache entry is expired. Does **not** consume the optimistic
  increment path.

Client:

- Settings screen shows "Storage: 340 MB / 1 GB (12 files)".
- Warn at 90% with copy pointing at the cap; no auto-action.
- Refresh on settings open; cheap enough to not need a push channel.

## Open questions (resolve before implementation)

- Should the indicator include `inbox/` and `users/` too, or is media
  the only interesting axis? Media is the only quota-enforced prefix in
  v0.1, but users may expect a total. Leaning "media only, labeled
  clearly" to avoid implying the other prefixes have a cap.
- When dedup ships, the displayed count diverges from "files I've
  sent" (one blob, many envelopes). Probably fine — "Storage" is about
  server bytes, not sent-message count — but worth naming carefully.
- Does the endpoint need rate limiting beyond the standard auth path?
  One call per settings-screen open is already rare; probably not.
- Any privacy concern with the server telling the client its exact
  blob count? Server already knows it; exposing it to the caller is
  fine.

## Out of scope

- Per-attachment listing / "delete this one" UI — that's the deletable-
  attachments indirection in
  [docs/evolution/media-gc.md](../docs/evolution/media-gc.md).
- Proactive notifications when approaching the cap — a warning in the
  settings screen is enough for v1.
