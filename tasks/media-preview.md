# Conditional in-chat preview + preview-first display (P1b)

Second Phase-1 step of [ADR-0022](../docs/decisions/adr-0022-multipart-media.md).
Even after [media-optimized-send](media-optimized-send.md), opening a chat shows
nothing for an image until the (now smaller, but still up to a few hundred KB)
full downloads. Attach a **tiny preview** (~50 KB) shown immediately, fetching
the full only on tap. Additive on `file` — no schema break.

## Spec

> An image attachment over a size/dimension threshold carries a small encrypted
> preview object. The preview renders immediately; the full image is fetched only
> on tap / when scrolled in. Below the threshold no preview is made — the
> (already small) full serves as its own preview.

Additive optional field on `file` (builds on P1a's fields), shown in its **wire**
form (base64url `key`/`iv`, as serialized inside the Megolm payload):

```jsonc
"file": {
  "...": "P1a fields (mime, width, height, optimized)",
  "preview": {                 // omitted below the threshold
    "url": "media/<uid>/<ulid>",
    "key": "<base64url AES-256-GCM key>",
    "iv":  "<base64url 12-byte IV>",
    "width": 320, "height": 240
  }
}
```

Preview: JPEG, ~512 px max edge, tuned to ≈50 KB
([ADR-0022](../docs/decisions/adr-0022-multipart-media.md) §3 — JPEG, not WebP,
because WebKit can't encode WebP via canvas). Threshold: generate only when the
**stored full** exceeds ~100 KB **or** ~1024 px on an edge (see §2 — the
threshold is on the full that's actually being previewed, not the picked file).

## Current

- After P1a, `sendMedia` ([useChatSend.ts](../web/src/hooks/useChatSend.ts))
  uploads a single (optimized) full object and writes the additive `file` fields
  via `prepareMediaForSend`. No second object, no `preview`.
- The wire/decoded split from P1a: `lib/media.ts` holds the **decoded** types
  (`MediaFile` with `Uint8Array` key/iv, plus the shared `MediaFileExtras`);
  `lib/payload.ts` holds the **wire** type (`ParsedMediaFile`, base64url key/iv,
  `extends MediaFileExtras`); `MediaPayload.file` in `lib/messaging.ts` *is*
  `ParsedMediaFile`. The materializer
  ([useChat.ts:70-81](../web/src/hooks/useChat.ts#L70-L81)) `base64UrlDecode`s
  the wire key/iv into the in-memory `MediaFile`.
- [useMedia.ts](../web/src/hooks/useMedia.ts) fetches + decrypts the **full**
  `file.url` (keyed by url; one-shot `IntersectionObserver`, abort, blob-revoke)
  and exposes `states: Record<url, MediaState>` + `observe(url, el)` +
  `request(url)`. There is no notion of a preview vs full.
- [MediaAttachment.tsx](../web/src/components/MediaAttachment.tsx) renders the
  reserved aspect-ratio box (from P1a's `width`/`height`) until the full is
  ready, then the `<img>`; it takes a single `state` prop and an `onRequest`
  callback. [ChatView.tsx:124-130](../web/src/components/ChatView.tsx#L124-L130)
  passes `mediaState={mediaStates[msg.media.url]}`.
- Deletion: [useChatAmendments.ts:54-61](../web/src/hooks/useChatAmendments.ts#L54-L61)
  — `deleteMessage(msgId, mediaUrl?)` calls `storeDelete` on a **single** url,
  fed `msg.media?.url` at [ChatView.tsx:157-160](../web/src/components/ChatView.tsx#L157-L160).
- `image.ts` (from P1a) provides `reencodeImage` + `isOptimizableImage`.

## Change

### 1. Types — additive `preview` (wire + decoded), mirroring P1a

`preview` is **not** a `MediaFileExtras` scalar — it is a sub-object whose
`key`/`iv` are base64url **strings** on the wire and decoded **`Uint8Array`** in
memory, so it follows the same two-form split as the file itself:

- [media.ts](../web/src/lib/media.ts) — add the **decoded** descriptor and hang
  it off `MediaFile`:
  ```ts
  export interface PreviewRef {
    url: string;
    key: Uint8Array;
    iv: Uint8Array;
    width: number;
    height: number;
  }
  // MediaFile gains:  preview?: PreviewRef;
  ```
- [payload.ts](../web/src/lib/payload.ts) — add the **wire** descriptor and hang
  it off `ParsedMediaFile` (so the outbound `MediaPayload.file` carries it for
  free):
  ```ts
  export interface WirePreviewRef {
    url: string;
    key: string;  // base64url
    iv: string;   // base64url
    width: number;
    height: number;
  }
  // ParsedMediaFile gains:  preview?: WirePreviewRef;
  ```
  `parseInner` reads `preview` best-effort: attach it only when `url/key/iv` are
  strings and `width/height` are numbers; absence (legacy / below-threshold) is
  fine.
- [useChat.ts](../web/src/hooks/useChat.ts) materializer — when `p.file.preview`
  is present, decode it alongside the top-level key/iv:
  ```ts
  ...(p.file.preview && {
    preview: {
      url: p.file.preview.url,
      key: base64UrlDecode(p.file.preview.key),
      iv: base64UrlDecode(p.file.preview.iv),
      width: p.file.preview.width,
      height: p.file.preview.height,
    },
  }),
  ```
- `messaging.ts` needs **no change** — `MediaPayload.file === ParsedMediaFile`.

### 2. Send — generate + upload the preview (conditional)

Constants in `image.ts` (reused by P1c's receiver-side thumbnail):
`PREVIEW_MAX_EDGE = 512`, `PREVIEW_TARGET_BYTES ≈ 50 * 1024`,
`PREVIEW_QUALITIES = [0.7, 0.6, 0.5]`, `PREVIEW_THRESHOLD_BYTES ≈ 100 * 1024`,
`PREVIEW_THRESHOLD_EDGE ≈ 1024`. Add a helper:

```ts
// Re-encode to a ~PREVIEW_TARGET_BYTES JPEG, stepping quality down the
// PREVIEW_QUALITIES ladder; returns the first under target, else the smallest.
export async function makePreview(src: Blob): Promise<Reencoded>;
```

In `sendMedia`, after `prepareMediaForSend(file)` yields `{ blob, extras }`
(`blob` is the **stored full** — the optimized JPEG, or the untouched original):

- **Gate + threshold (on the stored full, not the picked file).** Generate a
  preview only when `isOptimizableImage(extras.mime ?? file.type)` **and**
  (`blob.size > PREVIEW_THRESHOLD_BYTES` **or**
  `max(extras.width, extras.height) > PREVIEW_THRESHOLD_EDGE`). Use `extras`'
  dimensions (P1a already computed them for both the optimized and original
  paths). Generate the preview **from `blob`** (already decoded + smaller — no
  re-decoding the original).
- `makePreview(blob)` → encrypt with a **fresh** key/iv → upload as a
  **separate** object. Set `extras.preview = { url, key: b64, iv: b64, width,
  height }` (base64url key/iv — the wire form).
- **Upload-then-send:** PUT the full and the preview (concurrently —
  `Promise.all`) **before** sending the envelope. A failed send orphans both,
  swept by cleanup ([ADR-0006](../docs/decisions/adr-0006-data-retention.md)).
- Below the threshold, or a non-optimizable image (GIF/SVG), or a non-image: no
  preview object; `preview` omitted (full loads directly, exactly as today). A
  GIF thumbnail (static first-frame) is a deliberate **non-goal** here — see Out
  of scope; reusing `isOptimizableImage` keeps the gate consistent with P1a.

### 3. Display — preview first, full on tap

**`useMedia`** ([useMedia.ts](../web/src/hooks/useMedia.ts)) — keep the loader
keyed by the attachment's **full url**, but expose dual state and a second
request entry point. The internal url-keyed maps (controllers, blobs, observed)
stay as-is and simply span **both** the full and preview urls, so the one-shot /
abort / blob-revoke lifecycle is reused, not rewritten — teardown for a removed
message must release **both** urls.

```ts
export interface MediaItemState {
  thumb: MediaState; // in-chat render: the preview object, or the full when no preview
  full: MediaState;  // high-res; idle until an explicit tap (only meaningful when a preview exists)
}
export interface MediaLoader {
  states: Record<string, MediaItemState>; // keyed by full url
  observe: (fullUrl: string, el: HTMLElement | null) => void; // arms the THUMB load on scroll-in
  request: (fullUrl: string) => void;     // (re)load the thumb — chip click / thumb retry
  requestFull: (fullUrl: string) => void; // load the high-res full — image tap
}
```

- `observe` / scroll-in loads the **thumb**: the `file.preview` object when
  present (its url/key/iv), else the `file.url` full (today's behavior — so
  below-threshold images are unchanged).
- `requestFull` loads the **full** object into `full`. No-op shortcut when there
  is no separate preview (the thumb already is the full).
- Non-images keep using `request` (chip click → load full); they have no preview.

**`MediaAttachment`** ([MediaAttachment.tsx](../web/src/components/MediaAttachment.tsx))
— stays hook-free (props only; `useState` permitted but not needed):

- Replace the single `state` prop with `thumb?: MediaState` and
  `full?: MediaState`; add `onRequestFull?: () => void` (keep `onRequest` for the
  chip / thumb retry, and `width`/`height`/`observe` from P1a).
- Render priority inside the reserved box (no reflow): `full` ready → show
  `full.blobUrl`; else `thumb` ready → show `thumb.blobUrl` (blur-up: a light
  `blur-sm` until `full` arrives, when a preview exists). Tapping the image calls
  `onRequestFull` and **prevents navigation** until `full` is ready; once ready,
  the existing `<a href={full.blobUrl}>` opens/zooms the high-res. When there is
  no separate preview, the image behaves exactly as today (the `<a>` opens the
  full that's already loaded).

**`ChatView`** ([ChatView.tsx](../web/src/components/ChatView.tsx)) — pass
`thumb={mediaStates[msg.media.url]?.thumb}`, `full={mediaStates[msg.media.url]?.full}`,
and `onRequestFull={() => onRequestFull(msg.media.url)}` (wire `onRequestFull`
from `chat.tsx`'s `useMedia`).

### 4. Deletion — sweep both objects

Generalize the delete path from one url to the message's object set — the
permanent multi-object delete Phase 2 later extends to N attachments, not a
throwaway:

- `useChatAmendments`: `deleteMessage(msgId: string, mediaUrls: string[] = [])`
  — loop `storeDelete` over each url (each best-effort, independently logged).
- [ChatView.tsx:157-160](../web/src/components/ChatView.tsx#L157-L160): build the
  set at the call site —
  `[msg.media?.url, msg.media?.preview?.url].filter(Boolean) as string[]`.
- Note the multi-object delete in the v0.2 multipart section (it already states
  delete sweeps the full set); the v0.1 single-object `action: delete` text stays
  (multipart is a v0.2 surface).

## Verify

- `make lint test` — passes; architecture lint passes (component stays hook-free;
  full-fetch is a prop callback). `tsc` clean (the new wire/decoded `preview`
  types resolve; `MediaPayload.file` still equals `ParsedMediaFile`).
- Unit (`image.test.ts`): `makePreview` steps quality down and lands ≤ target on
  a large input; threshold predicate (preview made above bytes/edge, skipped
  below).
- Unit (`useChatSend.test.ts`): above-threshold optimizable image uploads **two**
  objects and sets `preview` (base64url key/iv); below-threshold uploads **one**,
  no `preview`; GIF/non-image → one object, no `preview`.
- Unit (`useMedia.test.ts`): with a `preview`, `observe`/scroll loads the
  **preview** url and `full` stays idle until `requestFull`, which loads the full
  url; without a `preview`, `observe` loads the full as before; teardown revokes
  both blobs.
- Unit (`payload.test.ts`): a `file` with a well-typed `preview` parses it; a
  malformed/absent `preview` is dropped (back-compat).
- `MediaAttachment.stories.tsx` — preview-loaded (blur-up), full-loaded
  (post-tap), and below-threshold (no-preview, thumb === full) states; light +
  dark.
- `pnpm tsc && pnpm build` (gate skips these).
- Manual on a throttled link: open a chat with large photos → previews appear in
  ~a moment, not after multi-100-KB downloads; tap → full loads and swaps with no
  reflow; delete a photo → **both** objects gone (usage drops by both); a small
  image (below threshold) shows directly with no second object.

## Out of scope

- **Offline preview cache** — [media-preview-cache](media-preview-cache.md) (P1c)
  persists these previews in IndexedDB.
- **Receiver-side thumbnail for preview-less images** — also P1c (it reuses
  `makePreview` on the downloaded full).
- **GIF (static first-frame) previews** — a follow-up; the `isOptimizableImage`
  gate skips GIF/SVG so previews stay raster-JPEG-only and consistent with P1a.
- **Albums / `attachments[]`** — Phase 2.
