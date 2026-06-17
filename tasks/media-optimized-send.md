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
- **Failure semantics:** `reencodeImage` *rejects* if the source can't be
  decoded (`createImageBitmap` throws) or `canvas.toBlob` yields `null`. It never
  silently returns the original — the caller decides the fallback (see §2). The
  primitive stays pure: decode → fit → encode, throw on any failure.
- Add a helper to read dimensions of an arbitrary image `Blob` (for the
  original path, which doesn't re-encode): `imageSize(src): Promise<{width,height}>`.

Constants: `OPTIMIZED_MAX_EDGE = 2048`, `OPTIMIZED_QUALITY = 0.8`.

### 2. `useChatSend.sendMedia` — optimize by default

- **What counts as "optimizable".** Only raster photos go through the canvas
  path: `file.type` is `image/jpeg`, `image/png`, or `image/webp`. Everything
  else — including **`image/gif`** (re-encoding would freeze an animation to a
  single JPEG frame) and **`image/svg+xml`** (vector; canvas re-encode is lossy
  and SVG is an XSS surface we don't want to round-trip) — is **not optimized**.
  Add an `isOptimizableImage(type: string): boolean` helper in `image.ts`
  alongside the primitive.
- **Non-images and non-optimizable images** (GIF, SVG, PDF, …) take the
  untouched path: encrypt + upload the raw file. For a *non-optimizable image* we
  still record `mime: file.type`, `optimized: false`, and `width`/`height` via
  `imageSize` (so the receiver gets zero-layout-shift sizing and an honest
  label). For a genuine non-image, add no new fields — behaviour is exactly as
  today.
- **Source-size guard.** The existing `MAX_MEDIA_BYTES` check lives in
  `encryptMedia`, which on the optimized path receives the *shrunken* result — so
  a 100 MB source would pass the gate yet choke the canvas. Reject **before**
  re-encoding: throw `FileTooLargeError` (reuse the existing class) when
  `file.size > MAX_MEDIA_BYTES`, for every path.
- For optimizable images, branch on the quality setting:
  - **Optimized (default):** `reencodeImage(file, {maxEdge: OPTIMIZED_MAX_EDGE, quality: OPTIMIZED_QUALITY})`
    → encrypt+upload the result → set `optimized: true`, `mime: 'image/jpeg'`,
    `width`/`height` from the result. Keep `name` (original filename) and set
    `size` to the optimized plaintext length (`EncryptedMedia.plaintextSize`,
    [media.ts:41](../web/src/lib/media.ts#L41)) — **not** `file.size`.
  - **Original (opt-out):** encrypt+upload the untouched file → `optimized: false`,
    `mime: file.type`, `width`/`height` via `imageSize`.
  - **Re-encode failure → fall back to original.** If `reencodeImage` rejects (an
    odd-but-decodable image the canvas can't round-trip), `console.warn` and send
    via the **original** path (`optimized: false`) rather than failing the send.
    A delivered full-quality image beats a failed send; the user just doesn't get
    the size win for that one file.

#### Quality setting (in scope — global, not per-send)

The default-vs-original choice is a **persisted global setting** (default
Optimized), mirroring WhatsApp's photo-quality option. A *per-send* override is
deferred to the P2 album composer — do **not** build composer UI here.

There is no client-preferences store yet (Settings panels are all server-backed;
the only local-pref precedent is [useDraft.ts](../web/src/hooks/useDraft.ts)
reading `localStorage` directly). Add a minimal one:

- **`web/src/lib/photo-quality.ts`** (leaf `lib` module — single source of truth
  for the key + default): `export type PhotoQuality = 'optimized' | 'original'`,
  a `PHOTO_QUALITY_KEY` constant, `getPhotoQuality(): PhotoQuality` (reads
  `localStorage`, defaults to `'optimized'`), and `setPhotoQuality(q)`.
- **`useChatSend.sendMedia` reads `getPhotoQuality()` at send time** — the
  `sendMedia(file)` signature is unchanged; the hook reads the live value
  synchronously inside the async send (no prop threading, no per-call argument).
- **`web/src/hooks/usePhotoQuality.ts`** — a tiny `useState`-backed wrapper over
  `get/setPhotoQuality` for the Settings UI (mirrors `useDraft`'s shape).
- **A small Settings panel component** (e.g. `PhotoQualitySetting.tsx`) wired into
  [settings.tsx](../web/src/routes/settings.tsx), with a Storybook story like the
  other panels. Two choices: *"Optimized (recommended)"* and *"Original quality —
  includes metadata"* (the label is honest until the original-path strip lands;
  see Out of scope).

### 3. Schema plumbing (new fields all optional **on the wire** — back-compat)

- [payload.ts](../web/src/lib/payload.ts) — `ParsedMediaFile` gains optional
  `mime?`, `width?`, `height?`, `optimized?`; `parseInner` reads them when present
  (validate types; absence is fine). The existing five-field guard stays the
  gate; new fields are best-effort.
- [media.ts](../web/src/lib/media.ts) `MediaFile` and the materializer
  ([useChat.ts:70-75](../web/src/hooks/useChat.ts#L70-L75)) carry the optional
  fields through.
- **Reserve layout space from `width`/`height` (required, not optional).** Thread
  the dimensions down the render path and size the image box by aspect ratio so
  the image lands at its final size with **zero load-time reflow**:
  - [ChatMessage.tsx:196-203](../web/src/components/ChatMessage.tsx#L196-L203) —
    pass `media.width` / `media.height` to `MediaAttachment` alongside the
    existing `name` / `size`.
  - [MediaAttachment.tsx](../web/src/components/MediaAttachment.tsx) — accept
    optional `width?` / `height?`. When both are present, give the placeholder
    **and** the loaded `<img>` an `aspect-ratio: w / h` box capped by the current
    `max-w-full` / `maxHeight: 400` (inline `style` is fine — `components/` allows
    it; no new hooks). The placeholder then occupies the exact footprint the image
    will fill, so swapping in the blob causes no shift.
  - **Absent dimensions** (legacy single-`file` messages, or a non-image) keep
    today's fixed `h-40 w-60` placeholder / current behaviour — no regression.
  - Add a `MediaAttachment` story variant with `width`/`height` set, verifying the
    aspect-ratio box in both themes.

## Verify

- `make lint test` — passes; new `image.ts` unit tests where feasible (size-fit
  math; dimension reader; `isOptimizableImage` returns false for `image/gif`,
  `image/svg+xml`, and non-images). Canvas/`createImageBitmap` may need a
  happy-dom shim or a thin mock — test the pure scaling math directly.
- `payload.test.ts` — a `file` with the new optional fields parses; a `file`
  without them still parses (back-compat).
- `photo-quality.test.ts` — default is `'optimized'` with no stored value;
  `set`→`get` round-trips.
- Storybook (`make web-storybook`) — the `MediaAttachment` dimensioned variant
  reserves the right box in light **and** dark; manually confirm an optimized
  image (carrying `width`/`height`) loads with **no layout shift**, while a legacy
  `file` (no dimensions) still falls back to the fixed placeholder.
- `pnpm tsc && pnpm build` (gate skips these).
- Manual: send a large photo (default) → stored object is a few hundred KB, not
  multi-MB; recipient sees the image; quota usage (`GET /v1/store/usage`) reflects
  the smaller size. Toggle "original quality" in Settings → untouched bytes sent.
  Send a photo with GPS EXIF on the default path → recipient's downloaded file has
  **no** EXIF (verify with `exiftool`). Send a portrait photo shot on a phone →
  not rotated (orientation baked). Send an **animated GIF** → recipient still sees
  it animate (not flattened to JPEG). Send a **non-image** → unchanged. Send an
  oversize (>25 MB) photo on the default path → rejected up front, not after a
  canvas stall.

## Out of scope

- **Original-path metadata strip** (targeted EXIF removal keeping orientation,
  [ADR-0022](../docs/decisions/adr-0022-multipart-media.md) §5) — a small
  follow-up; until then the original path is labeled as including metadata (no
  silent leak, since the *default* path strips).
- **Previews** — [media-preview](media-preview.md) (P1b) reuses `reencodeImage`.
- **`attachments[]` / albums** — Phase 2 (the clean break); this task stays on
  the single `file`.
- **Per-send quality override UI** — lands with the P2 composer.
