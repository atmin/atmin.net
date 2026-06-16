# Optimized-by-default photo send + EXIF strip (P1a)

First Phase-1 step of [ADR-0022](../docs/decisions/adr-0022-multipart-media.md).
Today a sent image is the **untouched original** — up to 25 MB, carrying its
EXIF (incl. GPS) to the recipient. Make the default a **downscaled, re-encoded,
metadata-stripped** image (≈10× smaller), with an **original-quality opt-out**.
Purely additive on the v0.1 single `file` — no schema break, fully
backward-compatible.

## Spec

> By default, a sent image is downscaled (cap ~2048 px), re-encoded as JPEG
> (q≈0.8), and stripped of metadata. An explicit "original quality" choice sends
> the untouched file. The choice is recorded so the receiver can label it.

Additive optional fields on `file` (old clients ignore them and render the full
image exactly as today — [ADR-0022](../docs/decisions/adr-0022-multipart-media.md) §8):

```jsonc
"file": {
  "url", "key", "iv", "name", "size",   // v0.1, unchanged
  "mime":  "image/jpeg",                 // declared type (layout hint; render still sniffs)
  "width": 2048, "height": 1536,         // stored-image dimensions
  "optimized": true                      // false / absent ⇒ original bytes were sent
}
```

Metadata stripping on the **optimized** path is free (canvas re-encoding carries
no source EXIF and bakes in orientation). The strip-by-default on the *original*
path (targeted EXIF removal that preserves orientation,
[ADR-0022](../docs/decisions/adr-0022-multipart-media.md) §5) is **out of scope
here** — see Out of scope; the original path in this task ships untouched bytes,
clearly labeled as including metadata, so there is no *silent* leak.

## Current

- [useChatSend.ts:51-90](../web/src/hooks/useChatSend.ts#L51-L90) — `sendMedia`
  encrypts the raw `File` as-is ([encryptMedia](../web/src/lib/media.ts#L44-L70)),
  uploads, and builds `{type:'media', body, file:{url,key,iv,name,size}}`. No
  downscale, no re-encode, no dimensions.
- [media.ts](../web/src/lib/media.ts) — AES-GCM encrypt/decrypt + `sniffInlineImageMime`;
  `MAX_MEDIA_BYTES = 25 MiB`. No image-processing helper exists.
- [payload.ts:12-69](../web/src/lib/payload.ts#L12-L69) — `ParsedMediaFile` /
  `parseInner` read exactly `{url,key,iv,name,size}`; extra fields are dropped.
- [MediaFile](../web/src/lib/media.ts#L29-L35) and the materializer
  ([useChat.ts](../web/src/hooks/useChat.ts)) carry the same five fields.

## Change

### 1. `web/src/lib/image.ts` — re-encode primitive (new, reused by P1b/P1c)

```ts
export interface Reencoded { blob: Blob; width: number; height: number; }

// Decode (honoring EXIF orientation), fit within maxEdge, re-encode as JPEG.
// The canvas round-trip strips all metadata and bakes orientation into pixels.
export async function reencodeImage(
  src: Blob,
  opts: { maxEdge: number; quality: number },
): Promise<Reencoded>;
```

- Decode with `createImageBitmap(src, { imageOrientation: 'from-image' })` so
  orientation is applied (otherwise optimized photos come out rotated).
- Scale so the longest edge ≤ `maxEdge` (never upscale); draw to a canvas;
  `canvas.toBlob('image/jpeg', quality)`.
- Main-thread canvas is fine (one-time, user-initiated send). Moving it to a
  worker is a later optimization, not needed now.
- Add a helper to read dimensions of an arbitrary image `Blob` (for the
  original path, which doesn't re-encode): `imageSize(src): Promise<{width,height}>`.

Constants: `OPTIMIZED_MAX_EDGE = 2048`, `OPTIMIZED_QUALITY = 0.8`.

### 2. `useChatSend.sendMedia` — optimize by default

- Detect image vs non-image (`file.type.startsWith('image/')`). **Non-images are
  unchanged** — encrypt + upload the raw file, no new fields.
- For images:
  - **Optimized (default):** `reencodeImage(file, {maxEdge: OPTIMIZED_MAX_EDGE, quality: OPTIMIZED_QUALITY})`
    → encrypt+upload the result → set `optimized: true`, `mime: 'image/jpeg'`,
    `width`/`height` from the result. Keep `name` (original filename) and set
    `size` to the optimized ciphertext-plaintext length.
  - **Original (opt-out):** encrypt+upload the untouched file → `optimized: false`,
    `mime: file.type`, `width`/`height` via `imageSize`.
- The quality choice is a **setting** (default Optimized), mirroring WhatsApp's
  photo-quality option — e.g. a toggle in Settings. A *per-send* override is
  deferred to the P2 album composer; do not build composer UI here. Label the
  original option clearly as *"original quality — includes metadata"* (honest
  until the original-path strip lands).

### 3. Schema plumbing (additive, optional everywhere)

- [payload.ts](../web/src/lib/payload.ts) — `ParsedMediaFile` gains optional
  `mime?`, `width?`, `height?`, `optimized?`; `parseInner` reads them when present
  (validate types; absence is fine). The existing five-field guard stays the
  gate; new fields are best-effort.
- [media.ts](../web/src/lib/media.ts) `MediaFile` and the materializer carry the
  optional fields through.
- Use `width`/`height` to reserve layout space in `MediaAttachment` (eliminates
  the load-time reflow). Optional but cheap, and it sets up P1b's placeholder.

## Verify

- `make lint test` — passes; new `image.ts` unit tests where feasible (size-fit
  math; dimension reader). Canvas/`createImageBitmap` may need a happy-dom shim
  or a thin mock — test the pure scaling math directly.
- `payload.test.ts` — a `file` with the new optional fields parses; a `file`
  without them still parses (back-compat).
- `pnpm tsc && pnpm build` (gate skips these).
- Manual: send a large photo (default) → stored object is a few hundred KB, not
  multi-MB; recipient sees the image; quota usage (`GET /v1/store/usage`) reflects
  the smaller size. Toggle "original quality" → untouched bytes sent. Send a
  photo with GPS EXIF on the default path → recipient's downloaded file has **no**
  EXIF (verify with `exiftool`). Send a non-image → unchanged. Send a portrait
  photo shot on a phone → not rotated (orientation baked).

## Out of scope

- **Original-path metadata strip** (targeted EXIF removal keeping orientation,
  [ADR-0022](../docs/decisions/adr-0022-multipart-media.md) §5) — a small
  follow-up; until then the original path is labeled as including metadata (no
  silent leak, since the *default* path strips).
- **Previews** — [media-preview](media-preview.md) (P1b) reuses `reencodeImage`.
- **`attachments[]` / albums** — Phase 2 (the clean break); this task stays on
  the single `file`.
- **Per-send quality override UI** — lands with the P2 composer.
