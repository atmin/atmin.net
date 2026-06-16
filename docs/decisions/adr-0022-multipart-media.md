# ADR-0022 — Multipart media: albums, previews, and metadata stripping

**Date:** 2026-06-14
**Status:** Draft.
**Relates to:** [ADR-0014](./adr-0014-message-amendments.md) (typed payload union; unknown-type-drop forward-compat), [ADR-0006](./adr-0006-data-retention.md) (cleanup must sweep every object a message references), [ADR-0001](./adr-0001-sync-first-s3-mailbox.md) (E2E; the server never sees plaintext or metadata), [ADR-0003](./adr-0003-ui-component-framework.md) (lightweight-bundle stance — weighed for the encoder choice), [mvp-v0.1.md](../specs/mvp-v0.1.md) ("Media" + "Payload by content type"), [v0.2.md](../specs/v0.2.md) (the wire shape lands here).

## Context

A media message today carries exactly **one** attachment. The inner
(Megolm-encrypted) payload is `{ type:'media', body, file:{url,key,iv,name,size} }`
([payload.ts](../../web/src/lib/payload.ts)), one encrypted object at
`media/{uid}/{ulid}`. Three gaps, all felt on a real device:

1. **No previews.** Opening a chat downloads and decrypts every attachment at
   full resolution — a 5 MB photo stalls the view on a slow link, and the
   original is the *only* representation that exists.
2. **One attachment per message.** A user sharing several photos sends several
   separate messages, and cannot describe each one.
3. **The original is the true original.** Up to 25 MB per image is stored and
   re-downloaded on view, and it carries the camera's EXIF — including GPS — to
   the recipient.

Changing the wire format is the expensive, migration-bearing part, so the
schema is widened **once** to cover all three rather than across several
rounds.

## Decision

### 1. Album schema — evolve `type:'media'` to a multipart shape

A media message becomes an optional message-level text plus an **ordered list of
attachments**, each with an optional caption, dimensions, and an optional
preview descriptor:

```jsonc
{
  "type": "media",
  "body": "vacation pics!",          // message-level text (optional)
  "attachments": [
    {
      "url": "media/U1/01HW…",        // full image, AES-256-GCM
      "key": "…", "iv": "…",          // per-object key + iv (base64url)
      "name": "beach.jpg",
      "size": 812345,
      "mime": "image/jpeg",           // layout hint only — see §5
      "width": 2048, "height": 1536,  // for zero-layout-shift sizing
      "caption": "sunset, night one", // per-attachment description (optional)
      "optimized": true,              // false ⇒ true original was sent (§4)
      "preview": {                    // omitted below the threshold (§3)
        "url": "media/U1/01HW…",
        "key": "…", "iv": "…",
        "width": 320, "height": 240
      }
    }
  ]
}
```

Text-only messages keep `type:'text'`. The album shape supersedes the single
`file` field; mixed types in one album are allowed (images render inline,
others as download chips).

### 2. Clean-break migration — no back-compat mirror

A new client writes `attachments` and **does not** write a legacy `file`. This
is safe because **parsing happens at render time, not at store time**: the
materializer decrypts the inner payload and persists it to IndexedDB as the raw
string; `parseInner` ([payload.ts](../../web/src/lib/payload.ts)) runs only when
building the message list. Consequently, for a pre-multipart ("stale") client:

- the message decrypts, is stored, and advances sync state normally;
- at render, the old `parseInner` fails the `file` guard and returns
  `{kind:'unknown'}`, so the message is **dropped, not rendered as garbage**
  (the [ADR-0014](./adr-0014-message-amendments.md) rule);
- on app update, the new `parseInner` reads `attachments` **from the same bytes
  already in IndexedDB** — the message reappears with **no re-download or
  re-sync**.

No data is lost (it persists in S3 *and* locally); the only effect is a feature
temporarily invisible on an un-upgraded client, self-healing on update. A
back-compat `file` mirror was therefore rejected as unnecessary complexity
(a deprecation window to track, an eventual removal) for a transient,
self-correcting, lossless gap. New clients keep reading the legacy single-`file`
shape **indefinitely** for historical archives — that reader is not removed.

### 3. Conditional client-side previews — JPEG

A small preview is generated **client-side at send** and uploaded as its **own**
AES-256-GCM object with its own key/iv, referenced by `attachment.preview`.

- **Conditional.** A preview is generated only when the original exceeds a
  threshold (~100 KB or ~1024 px on an edge). Below it, the original *is* its
  own preview and `preview` is omitted — no second object for a sticker.
- **JPEG, ~512 px max edge, quality tuned to ≈50 KB.** The codec is JPEG, not
  WebP, because WebKit (Safari, iOS `WKWebView`, WebKitGTK — the webviews a
  future Tauri/Capacitor build would use) does **not** support
  `canvas.toBlob('image/webp')` encoding and silently falls back to PNG, which
  would balloon previews on exactly the Apple platforms. `image/jpeg` is
  universally supported. AVIF has no reliable canvas encoder anywhere.
- **Display (images).** Show the preview immediately (blur-up); fetch the full
  image only on tap / when in view (see the lazy-load task).
- **Display (non-images).** A non-image attachment has no preview and is **never
  auto-downloaded**. It renders a **metadata-only chip** — a type icon (from
  `mime`/extension) + filename + size — straight from the payload, costing zero
  bytes; the file is fetched + decrypted only **on click** (to open/download).
  This fixes a current waste where a non-image attachment shows "Loading…" while
  the *entire* file downloads, only to then display a name + size + link that
  were already known from the payload ([MediaAttachment.tsx](../../web/src/components/MediaAttachment.tsx)).
  The chip needs no media cache — its data is the message payload, already in
  IndexedDB, so document history browses offline too. So the rule is: **image →
  preview (full on tap); non-image → metadata chip (full on click)** — neither
  auto-fetches the original.

A WebP/mozjpeg **WASM** encoder was considered and rejected: the install cost is
a one-time, cache-amortized tax (a fair trade for a recurring user benefit in
principle), but the *benefit* is ~15 KB per preview — ~1 % of an image's storage
footprint, which is dominated by the original. The quota lever is the original
(§4), not the preview codec.

### 4. Optimized-by-default originals, opt-in true original

The "full" image stored and sent is, by default, a **downscaled, re-encoded**
version (cap ~2048 px, JPEG q≈0.8 → typically a few hundred KB), via the same
canvas path as the preview. An explicit **"send original / original quality"**
opt-out stores the untouched file. `attachment.optimized` records which was
sent.

This is the real quota and bandwidth win (≈10× over a multi-MB original) and
also shrinks the on-tap full-image fetch. The opt-out respects
quality/privacy-conscious users who want the untouched bytes — the same audience
[ADR-0020](./adr-0020-registration-proof-of-work.md) serves.

### 5. Metadata stripped by default — on **both** paths

Image EXIF (GPS, timestamp, device, software) is stripped by default:

- **Optimized path: stripped for free.** Canvas re-encoding draws from raw
  pixels and carries no source metadata into the output. The default send is
  Signal-grade on metadata with no extra work.
- **Original path: also stripped by default**, with an explicit **"keep
  metadata"** opt-in. This is the one place metadata can leak (the untouched
  file carries EXIF), and is exactly where WhatsApp ("send as document") and
  Telegram ("send as file") leak silently. Stripping by default even here is a
  deliberately stronger stance than any mainstream messenger.
- **Orientation is preserved.** The strip pass removes GPS/timestamp/device but
  keeps the EXIF orientation tag (or bakes it into pixels), so an un-recompressed
  original does not display rotated. The optimized path sidesteps this — canvas
  bakes orientation already.

The threat model is specific to this system: because media is encrypted
client-side, the **server never sees EXIF** ([ADR-0001](./adr-0001-sync-first-s3-mailbox.md)).
Stripping protects the sender from leaking location/device to the **recipient**
(and onward), not from the platform. Stripping is image-only; non-image
originals (PDF, etc.) ship as-is — not an implied promise.

### 6. Keying, limits, atomicity, edit scope

- **Per-object key + iv** for every object (full and preview), as today — keeps
  objects independent so a per-image delete is clean.
- **Limits:** ≤ 10 attachments per message; the per-file 25 MB cap stands. Every
  object (full + preview) counts against the per-user media quota.
- **Send is upload-then-send:** all objects upload, then one envelope is sent. A
  send failure leaves orphaned objects, reclaimed by the
  [ADR-0006](./adr-0006-data-retention.md) cleanup sweep.
- **Deletion** ([ADR-0014](./adr-0014-message-amendments.md) delete amendment)
  must collect the message's **full** object set (every attachment + preview),
  not a single URL.
- **Edit scope:** amendments edit the message-level `body` only; per-attachment
  captions are immutable for now. Keeps the edit surface bounded.

### 7. Local media cache — offline history browsing

Decrypted message *text* already lives in IndexedDB, so text history reads
offline; media does not — it is held only as in-memory object URLs and
re-fetched from S3 on every chat open ([useMedia.ts](../../web/src/hooks/useMedia.ts)).
Close that gap with a **best-effort IndexedDB cache of decrypted media blobs**,
keyed by S3 URL. Media objects are write-once, so a cached entry is **never
stale** — no invalidation logic.

Guiding principle: **the cache is never the source of truth — S3 is.** A miss or
an eviction degrades to exactly today's fetch-and-decrypt, so eviction can be
aggressive and failures are harmless. The cache check layers into `useMedia`'s
fetch path (check IDB → else fetch + decrypt + store), composing with the
lazy-load-on-scroll change.

**v1 — offline *browsing* (the win this targets):**

- **Cache every preview on fetch.** Tiny (~50 KB); makes album grids, history
  scrolling, and captions fully offline.
- **Receiver-side thumbnail for preview-less images.** A legacy single-`file`
  message or a below-threshold image has no sender preview. On the first full
  download, downscale it through the same canvas pipeline and cache that as the
  local preview, so subsequent browsing is offline and cheap. This still
  requires downloading the full **once** — but that is the behavior today, so it
  is strictly an improvement, never a regression. The derived thumbnail is
  **local-only**: a recipient has no write permission to the sender's
  `media/{uid}/…` prefix, so it is never uploaded; each device generates its own.
- **Below-threshold smalls:** cache the original directly (it *is* small) and use
  it as both preview and full — no separate snapshot.
- **Request persistent storage** (`navigator.storage.persist()`) to reduce
  eviction under pressure, but never depend on it.
- **Purge on delete and on 404.** A delete amendment
  ([ADR-0014](./adr-0014-message-amendments.md)) drops the cached blobs too, so a
  deleted image does not linger locally; a server 404 (retention swept it,
  [ADR-0006](./adr-0006-data-retention.md)) evicts the entry.

**v2 — offline *everything* (deferred, low priority):** also cache full
originals under an LRU byte budget, so tapping a large image works offline. The
marginal value over v1 is small (browsing already works; full-on-tap offline is
a narrow case) and it introduces an eviction policy and a storage cap. Out of
scope for the first cut; revisit only if it is actually missed.

**Security:** this stores *decrypted* media at rest in IndexedDB — the same
exposure class as the decrypted message text and Megolm session pickles already
there. The device is trusted; the threat model is the server/network
([ADR-0001](./adr-0001-sync-first-s3-mailbox.md)). Not a new trust boundary.

One property worth stating: a cached preview lets locally-retained history
survive **after** the server purges the original under retention — the device's
copy outlives server-side retention, by design.

## Consequences

- Users share albums with per-image descriptions; chats open fast (tiny previews
  first, full image on demand); default sends are an order of magnitude smaller
  *and* metadata-clean — a privacy story stronger than WhatsApp/Telegram on the
  axis they fumble.
- **More objects per message** (up to ~2N). The single-URL delete path
  ([useChat](../../web/src/hooks/useChat.ts) / the delete amendment) and the
  cleanup sweep both change to operate on a set. This is the main correctness
  surface.
- **The wire format breaks for un-upgraded clients**, but losslessly and
  transiently (§2). No migration window or mirror to maintain; the legacy
  single-`file` reader stays for historical archives.
- **Default sends are lossy** (downscaled, metadata-stripped). The "send
  original / keep metadata" opt-outs exist precisely so this is a default, not a
  cage.
- Generation is client-side CPU at send (downscale + encode, ×N for albums) —
  acceptable, one-time per send, off the critical receive path.
- Media history browses offline (§7), closing the gap with text; local decrypted
  blobs are bounded (previews + below-threshold smalls in v1) and best-effort, so
  storage stays modest and eviction is safe.

## Alternatives considered

- **General `blocks[]` (interleaved text + media).** More future-proof, but adds
  edit/render complexity and is a brand-new type old clients drop entirely. Chat
  users compose albums, not interleaved posts. Rejected for the album shape.
- **Back-compat `file` mirror during a deprecation window.** Nearly free, but
  unnecessary: §2's render-time parsing makes the clean break lossless and
  self-healing. Rejected as complexity without benefit.
- **WebP / AVIF / WASM-encoded previews.** WebP isn't encodable on WebKit
  webviews; AVIF has no canvas encoder; a WASM encoder's gain (~15 KB/preview) is
  noise against the original's footprint. Rejected for native canvas JPEG.
- **Always store the true original.** Simpler, but multiplies quota and
  bandwidth and ships EXIF by default. Rejected for optimized-by-default with an
  opt-out.
- **Metadata stripping as an opt-in only (mainstream-messenger behavior).**
  Leaves the original path leaking by default — the documented WhatsApp/Telegram
  footgun. Rejected for strip-by-default with an opt-in to preserve.
