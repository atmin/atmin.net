# Local media cache — offline preview browsing (P1c)

Third Phase-1 step of [ADR-0022](../docs/decisions/adr-0022-multipart-media.md)
(§7, v1). Decrypted message *text* lives in IndexedDB, so text history reads
offline — but media is held only in memory and re-fetched from S3 on every chat
open. Persist decrypted **previews** (and below-threshold small originals) so
media history browses offline, with no re-download on refresh.

## Spec

> A decrypted preview (or a below-threshold small original) is cached in
> IndexedDB on first fetch and served from there afterward — so media history
> browses offline and survives refresh without re-downloading. The cache is
> best-effort: a miss or eviction simply re-fetches from S3.

Cache **previews + below-threshold smalls** only. Full originals are **not**
cached (deferred v2 — [ADR-0022](../docs/decisions/adr-0022-multipart-media.md)
§7). Decrypted-at-rest is the same exposure class as the message text and Megolm
pickles already in IndexedDB ([ADR-0001](../docs/decisions/adr-0001-sync-first-s3-mailbox.md);
device trusted, threat model is server/network) — not a new trust boundary.

## Current

- After P1b, in-chat rendering fetches the preview (or, when there is none, the
  full) via [useMedia.ts:46-92](../web/src/hooks/useMedia.ts#L46-L92), holds it as
  an in-memory object URL ([blobsRef](../web/src/hooks/useMedia.ts#L37)), and
  **revokes it on unmount** ([useMedia.ts:117-126](../web/src/hooks/useMedia.ts#L117-L126)).
  Nothing media-related is persisted — [db.ts](../web/src/lib/db.ts) has no media
  store (`DB_VERSION` is 7; raised to 8 by [archive-ingest-cache](archive-ingest-cache.md)
  if that lands first — coordinate the version bump).
- `image.ts` (P1a) provides `reencodeImage` for receiver-side thumbnails.
- The delete path (P1b) already sweeps a message's media objects.

## Change

### 1. New IDB store: `media_cache`

[db.ts](../web/src/lib/db.ts) — bump `DB_VERSION` and add a store keyed by S3 URL
(media objects are write-once → a cached entry is **never stale**, no invalidation):

```ts
export interface StoredMediaBlob {
  url: string;        // S3 key — primary key
  bytes: ArrayBuffer; // decrypted plaintext
  mime: string;       // sniffed inline MIME (or 'application/octet-stream')
  cachedAt: number;   // ms epoch — for optional future LRU
}
```

Helpers: `getMediaBlob(url)`, `putMediaBlob(entry)`, `deleteMediaBlob(url)`,
mirroring the existing `db.ts` helper style. (If `archive-ingest-cache` also bumps
the version, do both stores in one `onupgradeneeded` step.)

### 2. `useMedia` — read-through cache

In the load path: **check `media_cache` first** → hit: build the object URL from
the cached bytes, no network; miss: fetch + decrypt as today, then `putMediaBlob`.
Apply this to the **preview** load (and to a below-threshold full, which P1b loads
directly). Keep object-URL lifecycle as-is for the in-memory handle; the cache is
the durable layer beneath it. Best-effort: any cache error falls through to fetch.

### 3. Receiver-side thumbnail for preview-less images

When an image with **no `preview`** has its full downloaded (legacy single-`file`,
or a below-threshold image whose full *is* small), after decrypt:

- below-threshold small: cache the decrypted full directly (it *is* the preview);
- larger preview-less image: `reencodeImage` it to a ~512 px JPEG and cache **that**
  as the local preview, so subsequent browsing is offline and cheap.

This is **local-only** — a recipient cannot upload to the sender's `media/{uid}/…`
prefix, so the derived thumbnail is never sent; each device makes its own. It
requires downloading the full **once**, which is today's behavior — strictly an
improvement, no regression.

### 4. Persistence + eviction

- Request `navigator.storage.persist()` once (reduce eviction under pressure);
  never depend on it — a miss re-fetches.
- **Purge on delete** (extend P1b's delete sweep to also `deleteMediaBlob` each
  swept URL, so a deleted image does not linger locally) and **on a server 404**
  (retention swept the original, [ADR-0006](../docs/decisions/adr-0006-data-retention.md)
  → evict the entry).

## Verify

- `make lint test` — passes; `db.test.ts` covers put/get/delete and the version
  upgrade (coordinated with archive-ingest-cache if both land).
- `useMedia` test: a cached URL is served without calling `fetchMedia`; a miss
  fetches then writes the cache; a cache read error falls through to fetch.
- Test: deleting a message evicts its cached blobs; a 404 evicts the entry.
- Test: a preview-less image, once downloaded, leaves a cached local thumbnail.
- `pnpm tsc && pnpm build` (gate skips these).
- Manual: load a chat with media online; go offline; refresh → previews still
  render from cache, no network; delete a media message → its cache entry is gone.

## Out of scope

- **Caching full originals** under an LRU byte budget (offline full-on-tap) —
  deferred v2 ([ADR-0022](../docs/decisions/adr-0022-multipart-media.md) §7);
  revisit only if actually missed.
- **Albums / `attachments[]`** — Phase 2; this task operates on the single-`file`
  preview/full from P1a/P1b.
