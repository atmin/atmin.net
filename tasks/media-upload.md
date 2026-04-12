# Client-side encrypted media upload and download

## Spec

Authoritative: [docs/specs/mvp-v0.1.md — Media](../docs/specs/mvp-v0.1.md#media).
Scenario: [docs/scenarios/media.md](../docs/scenarios/media.md).
Future: [docs/evolution/large-media.md](../docs/evolution/large-media.md),
[docs/evolution/media-gc.md](../docs/evolution/media-gc.md).

Summary: client generates a random AES-256-GCM key + 12-byte IV, encrypts
a file in a single shot, presigns upload to `media/{userId}/{ulid}`,
uploads the encrypted blob, sends a Megolm-encrypted message carrying
the key/IV/name/size. GCM's auth tag is the sole integrity check; no
SHA-256 or MIME travels in the envelope.

Recipient fetches the ciphertext, AES-GCM-decrypts, sniffs magic bytes,
and renders inline (PNG/JPEG/GIF/WebP) or as a download link.

## Current state

- [web/src/components/ChatView.tsx](../web/src/components/ChatView.tsx) is
  text-only: no file picker, no media rendering.
- [web/src/lib/api.ts](../web/src/lib/api.ts) has no media upload/download
  helpers.
- [web/src/hooks/useChat.ts](../web/src/hooks/useChat.ts) has `sendMessage`
  but no `sendMedia`.
- [server/handlers.go](../server/handlers.go) `handleStoreObject` does not
  set `Cache-Control`; `handleStorePresign` does not enforce the per-blob
  cap nor the per-user quota.
- No `media` variant in [web/src/components/ChatMessage.tsx](../web/src/components/ChatMessage.tsx)
  or its stories file.
- Error codes in [server/error.go](../server/error.go) include
  `quota_exceeded` but not `too_large`.

## Constants

Defined once on each side, cross-referenced by comment:
- `MAX_MEDIA_BYTES = 25 * 1024 * 1024` (25 MiB ciphertext)
- `USER_MEDIA_QUOTA_BYTES = 1 << 30` (1 GiB)
- `USER_MEDIA_BLOB_CAP = 1000` (one `ListObjectsV2` page)
- `QUOTA_CACHE_TTL = 10 * time.Minute`
- `MEDIA_FETCH_TIMEOUT_MS = 60_000`

## Changes

### Client crypto — `web/src/lib/media.ts` (new)

```ts
export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

export class FileTooLargeError extends Error {}
export class MediaCorruptError extends Error {}

export interface EncryptedMedia {
    ciphertext: Uint8Array; // plaintext.length + 16 (GCM tag)
    key: Uint8Array;        // 32 bytes
    iv: Uint8Array;         // 12 bytes
    plaintextSize: number;  // for the envelope's `size` field
}

export async function encryptMedia(file: File): Promise<EncryptedMedia>;

export async function decryptMedia(
    ciphertext: Uint8Array,
    key: Uint8Array,
    iv: Uint8Array,
): Promise<Uint8Array>;

/** First 12 bytes of plaintext → one of the v0.1 inline MIME types or null. */
export function sniffInlineImageMime(
    plaintext: Uint8Array,
): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null;

export function sanitizeDownloadFilename(name: string): string;
```

Magic bytes to match:
- PNG: `89 50 4E 47 0D 0A 1A 0A`
- JPEG: `FF D8 FF`
- GIF: `47 49 46 38 (37|39) 61`
- WebP: `52 49 46 46 ?? ?? ?? ?? 57 45 42 50`

### Client API — `web/src/lib/api.ts`

Add:

```ts
export async function uploadMedia(
    token: string,
    userId: string,
    encrypted: EncryptedMedia,
    abort?: AbortSignal,
): Promise<{ url: string; mediaUlid: string }>;
```

Behavior:
1. Generate a ULID for the blob; build `key = media/{userId}/{ulid}`.
2. `POST /v1/store/presign` with `{ key, bytes: ciphertext.length }`.
3. `PUT` the ciphertext to the presigned URL with
   `Content-Type: application/octet-stream` (unsigned); `Content-Length`
   is set by the browser and must match the signed value exactly.
4. Retry once on network error or HTTP 5xx (same URL if within the
   presign validity window; re-presign after 1 h).
5. On success, return `{ url: key, mediaUlid: ulid }`.

Add also:

```ts
export async function fetchMedia(
    token: string,
    url: string,
    abort: AbortSignal,
): Promise<Uint8Array>;
```

Reads `/v1/store/object?key=<url>` with a 60 s timeout. Throws typed
errors distinguishable by the caller: `NotFoundError`, `NetworkError`.

### Send flow — `web/src/hooks/useChat.ts`

Add `sendMedia(file: File)` mirroring `sendMessage(text: string)`:

1. `enc = encryptMedia(file)` — throws `FileTooLargeError` for >25 MB.
2. `{ url } = uploadMedia(..., enc)`.
3. Build inner Megolm plaintext:

    ```ts
    {
      type: 'media',
      body: file.name,
      file: {
        url,
        key: base64(enc.key),
        iv:  base64(enc.iv),
        name: file.name,
        size: file.size,
      }
    }
    ```
4. Send via existing Megolm path.
5. On PUT-then-send failure: surface retry; do not delete the orphan
   blob (no v0.1 delete endpoint; see
   [evolution/media-gc.md](../docs/evolution/media-gc.md)).

### Rendering — `web/src/components/MediaAttachment.tsx` (new)

Props: `{ file: MediaFile, token: string }`.

State machine: `idle → loading → decrypting → ready | corrupt | unavailable | network-error`.

- On mount: fetch + decrypt via `AbortController`. Set data attrs for
  test selectors: `data-testid="media-attachment"`,
  `data-status="..."`.
- On `ready`:
  - If `sniffInlineImageMime(plaintext)` ≠ `null` → `<img src={blobUrl}
    alt={name} data-testid="media-image"
    style="max-width:100%;max-height:400px;object-fit:contain">`,
    wrapped in `<a href={blobUrl} target="_blank" rel="noopener
    noreferrer">` to let the user open the full-resolution image in a
    fresh tab. Navigation to a blob URL is permitted; iframe/embed are
    not used.
  - Else → `<a download={sanitizeDownloadFilename(name)}
    href={blobUrl} data-testid="media-download" rel="noopener noreferrer">{displayName} · {formatBytes(size)}</a>`,
    where `displayName` is `sanitizeDownloadFilename(name)`.
- On `corrupt` / `unavailable`: inline error copy; no retry.
- On `network-error`: inline retry button that resets to `loading`.
- Cleanup: `URL.revokeObjectURL(blobUrl)` and `abort()` on unmount.

Wire it into [ChatMessage.tsx](../web/src/components/ChatMessage.tsx)
when the decrypted payload has `type: 'media'`. The message bubble still
renders timestamp and caption (`body`) regardless of attachment status.

### File input — `web/src/components/ChatView.tsx`

Add a file picker button next to the text input. On selection, call
`onSendMedia(file)` (new prop). Keep the existing `onSend` for text.

### Server — `server/handlers.go`

In `handleStoreObject`: when `strings.HasPrefix(key, "media/")`, set
`Cache-Control: private, immutable, max-age=31536000` on the response.
Always set `Content-Type: application/octet-stream` regardless of what
S3 returns (the stored content type is caller-controlled and must not
leak through).

In `handleStorePresign`:
- Reject `bytes > MAX_MEDIA_BYTES` with `413 too_large`.
- If `strings.HasPrefix(key, "media/")`, enforce the per-user quota and
  blob-count cap via a new in-process `MediaQuota` store (see below).
- Sign the URL with `Content-Length` equal to `bytes`. Do **not** sign
  `Content-Type` — leave it unsigned so the client can send
  `application/octet-stream` without coordination.

Add `errTooLarge` in [server/error.go](../server/error.go).

### Server — `server/media_quota.go` (new)

Same "in-process now, shared-state later" pattern as
[`server/events.go`](../server/events.go) (EventHub). One `sync.Map`
keyed by `user_id`, value `{ usageBytes, blobCount, expiresAt }`. On
presign:

1. Under per-user mutex, if expired → `ListObjectsV2("media/{uid}/")`,
   sum `Size`, count objects, cache for 10 min.
2. If `blobCount + 1 > USER_MEDIA_BLOB_CAP` or
   `usageBytes + bytes > USER_MEDIA_QUOTA_BYTES` → `413 quota_exceeded`.
3. Else optimistically bump `usageBytes += bytes`, `blobCount += 1`, and
   return the signed URL. The increment is not reverted on unused
   presigns; the next TTL refresh rebuilds from S3.

Interface `MediaQuotaStore` with methods `ReserveUpload(uid, bytes)
(ok, reason)` and `Invalidate(uid)`. The in-process implementation is
the only one in v0.1; a Redis-backed implementation can be swapped in
later without touching handlers. Reference the EventHub precedent
inline with a comment pointing at
[adr-0004-sse-realtime-notifications.md](../docs/decisions/adr-0004-sse-realtime-notifications.md#redis-pubsub-from-day-one).

### Server — paging

`ListObjectsV2` returns up to 1000 keys per page. The blob-count cap is
chosen so one page always suffices — no pagination loop. A log warning
(`media_quota.list_truncated`) fires if `IsTruncated=true` is ever seen
(indicates the cap enforcement drifted; should not happen).

## Verify

```
cd server && go test ./...          # new: cache-control + quota tests
cd web && npx tsc --noEmit
cd web && npm test                  # new: media.test.ts, MediaAttachment.test.tsx
cd web && npx playwright test e2e/media.spec.ts
```

## Tests

### Unit — server

In [server/handlers_test.go](../server/handlers_test.go):
- `TestStoreObject_MediaSetsCacheControl`: GET `/v1/store/object?key=media/<uid>/<ulid>`
  returns `Cache-Control: private, immutable, max-age=31536000`.
- `TestStoreObject_InboxNoCacheControl`: GET inbox key returns no
  `Cache-Control` header.
- `TestPresign_TooLarge`: `bytes = 26 MiB` → 413 `too_large`.
- `TestPresign_QuotaExceeded`: pre-populate `media/<uid>/` with blobs
  summing near the 1 GiB cap; presign requesting more → 413
  `quota_exceeded`.
- `TestPresign_BlobCountCap`: pre-populate 1000 tiny blobs; presign
  requesting one more byte → 413 `quota_exceeded` (same code, reason
  string distinguishes in logs).
- `TestPresign_QuotaCacheTTL`: second call within TTL does not re-list.
- `TestPresign_ContentLengthSigned`: presign for `bytes=100`, then PUT
  a 200-byte body to the returned URL against a real MinIO (or httptest
  S3 mock that validates SigV4). Assert the PUT is rejected. Covers the
  "cannot smuggle a larger file" claim.
- `TestPresign_ContentTypeNotSigned`: PUT with
  `Content-Type: application/octet-stream` succeeds; same URL with
  `Content-Type: text/html` also succeeds (confirms Content-Type is not
  in SignedHeaders). Pair assertion: `handleStoreObject` response for
  the stored object has `Content-Type: application/octet-stream`
  regardless.
- `TestMediaQuota_OptimisticIncrementNotReverted`: ReserveUpload for
  100 bytes, do **not** upload, call again within TTL for 100 more
  bytes — the second call sees usage = 200.

### Unit — client

`web/src/lib/media.test.ts`:
- `encryptMedia` / `decryptMedia` round-trip for a known fixture yields
  byte-identical plaintext.
- `decryptMedia` throws `MediaCorruptError` on a flipped ciphertext byte.
- `decryptMedia` throws on a flipped IV byte.
- `decryptMedia` throws when called with the wrong key.
- `encryptMedia` throws `FileTooLargeError` for a `File` of size
  `MAX_MEDIA_BYTES + 1`, *before* touching `crypto.subtle`.
- `sniffInlineImageMime` returns the correct MIME for PNG/JPEG/GIF/WebP
  fixture headers and `null` for SVG (`<?xml`, `<svg`), PDF (`%PDF`),
  MP4 (`ftyp`), plain text, and all-zero bytes.
- `sanitizeDownloadFilename`: strips `/`, `\`, `\0`, control chars
  (`\x01`, `\x1f`, `\x7f`, `\r`, `\n`, `\t`), leading `.`, empty input
  → `"download"`, 300-char input → truncated to 255 bytes.

`web/src/components/MediaAttachment.test.tsx`:
- Mount → sets `data-status="loading"` → `"ready"`; `<img>` visible.
- Unmount during loading → `AbortController.abort()` called; no state
  update after unmount.
- Unmount after ready → `URL.revokeObjectURL` called with the created
  URL.
- Remount after unmount → re-fetches (no in-app cache; browser HTTP
  cache may serve, but the component re-decrypts).
- In a virtualized list: scroll the message out of view (unmount) and
  back (remount) → a fresh ObjectURL is allocated, the previous one was
  revoked, no stale URL leaks.
- 404 from fetch → `data-status="unavailable"`.
- Corrupt ciphertext in fixture → `data-status="corrupt"`.
- Non-image plaintext → renders `<a data-testid="media-download">`
  instead of `<img>`.

### Storybook

Add to [ChatMessage.stories.tsx](../web/src/components/ChatMessage.stories.tsx):
`mediaImage`, `mediaDownload`, `mediaCorrupt`, `mediaUnavailable`,
`mediaLoading`.

### E2E — `web/e2e/media.spec.ts` (new)

Fixtures in `web/e2e/fixtures/`:
- `photo.png` (small PNG, < 100 KB)
- `blob.bin` (1 KB random bytes, no recognizable magic)
- `huge.bin` (generated in test: 26 MiB of zeros)

Helpers in `web/e2e/helpers.ts`: add `sendMedia(page, filePath)` and
`waitForMediaImage(page)` / `waitForMediaDownload(page)`.

Cases (all build on the First Conversation helper pattern: Alice and
Bob register, both open the chat):

1. **Golden — inline image.** Alice sends `photo.png`. Bob waits for
   `[data-testid="media-image"]` and asserts `naturalWidth > 0`. Fetch
   the rendered blob URL, hash its bytes, and assert it equals the
   SHA-256 of `photo.png`.
2. **Browser cache on refresh.** After case 1, instrument Playwright
   route handler to count `GET /v1/store/object?key=media/...` hits.
   Reload Bob's page. Image re-renders; route handler saw **zero**
   additional media hits.
3. **Download variant.** Alice sends `blob.bin`. Bob waits for
   `[data-testid="media-download"]`; asserts `[data-testid="media-image"]`
   is absent; link has a `download` attribute.
4. **Oversize rejected client-side.** Alice attaches `huge.bin`.
   Instrument a route handler to count `POST /v1/store/presign` hits.
   An inline error is visible; presign handler saw **zero** hits.
5. **Corrupt blob.** Alice sends `photo.png`. After Bob sees it,
   overwrite the stored ciphertext at the same `key` with random bytes
   of the same length (directly against the S3 backend in the test, not
   via presign). Then open the chat in a **fresh Playwright browser
   context** — new `browser.newContext()` so the immutable HTTP cache
   does not serve the original bytes. Assert
   `[data-testid="media-attachment"][data-status="corrupt"]`; message
   bubble (timestamp) is still visible.

   Note: this case exercises the "last-write-wins" overwrite behavior,
   which is why v0.1 uses ULID paths instead of content-addressed paths
   — an attacker (or a buggy re-upload flow) overwriting a blob breaks
   re-decryption but cannot substitute undetectable content. The fresh
   context is required because `Cache-Control: immutable, max-age=1y`
   is otherwise doing its job and hiding the overwrite from the client.

6. **Send succeeds once after a transient `/v1/send` failure.** Alice
   attaches `photo.png`. Instrument a Playwright route handler on
   `POST /v1/send` to fail the first call (503) and let the second
   through. The PUT to `media/...` must only fire once (presign route
   handler counts one hit). Bob receives exactly one message — assert
   there's a single `[data-testid="media-attachment"]` in his view,
   not two.

## Out of scope for this task

- Chunked encryption / resumable uploads / MSE playback —
  [evolution/large-media.md](../docs/evolution/large-media.md).
- Orphan garbage collection + `DELETE /v1/store/object` —
  [evolution/media-gc.md](../docs/evolution/media-gc.md).
- IndexedDB / Service Worker cache of decrypted plaintext — deliberately
  excluded (privacy).
- Automatic retry for download network errors — manual retry only.
- Progress indicators — spinner only, no progress bar.
- Inline SVG/AVIF/HEIC/video/audio/PDF — download-only in v0.1.
