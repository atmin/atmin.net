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

Additive optional field on `file` (builds on P1a's fields):

```jsonc
"file": {
  "...": "P1a fields (mime, width, height, optimized)",
  "preview": {                 // omitted below the threshold
    "url": "media/<uid>/<ulid>",
    "key": "<base64 AES-256-GCM key>",
    "iv":  "<base64 12-byte IV>",
    "width": 320, "height": 240
  }
}
```

Preview: JPEG, ~512 px max edge, tuned to ≈50 KB
([ADR-0022](../docs/decisions/adr-0022-multipart-media.md) §3 — JPEG, not WebP,
because WebKit can't encode WebP via canvas). Threshold: generate only when the
source exceeds ~100 KB **or** ~1024 px on an edge.

## Current

- After P1a, `sendMedia` uploads a single (optimized) full object and writes the
  additive `file` fields. No second object, no `preview`.
- [useMedia.ts:46-92](../web/src/hooks/useMedia.ts#L46-L92) fetches + decrypts the
  **full** `file.url` and renders it; there is no notion of a preview vs full.
- [MediaAttachment.tsx:17-72](../web/src/components/MediaAttachment.tsx#L17-L72)
  shows "Loading…" until the full is ready, then the `<img>`.
- Deletion ([useChat](../web/src/hooks/useChat.ts) / the delete amendment, and
  `DELETE /v1/store/object`) removes a **single** `media/{uid}/{ulid}` — see the
  v0.1 amendment spec ([mvp-v0.1.md](../docs/specs/mvp-v0.1.md) `action: delete`).
- `image.ts` (from P1a) provides `reencodeImage`.

## Change

### 1. Send — generate + upload the preview (conditional)

In `useChatSend.sendMedia`, for an image whose source exceeds the threshold:

- `reencodeImage(file, {maxEdge: PREVIEW_MAX_EDGE, quality: PREVIEW_QUALITY})`
  (`512`, `~0.7`); if the result still exceeds the ≈50 KB target, step quality
  down once or twice. Encrypt (fresh key/iv) and upload as a **separate** object.
- Attach `file.preview = {url, key, iv, width, height}`.
- **Upload-then-send:** both objects PUT before the envelope is sent (the full
  may upload concurrently with the preview). A failed send orphans both, swept by
  cleanup ([ADR-0006](../docs/decisions/adr-0006-data-retention.md)).
- Below the threshold: no preview object; `preview` omitted.

### 2. Display — preview first, full on tap

- [payload.ts](../web/src/lib/payload.ts) / `MediaFile` carry the optional
  `preview` descriptor.
- `useMedia` ([useMedia.ts](../web/src/hooks/useMedia.ts)): when a `preview`
  exists, load **it** for the in-chat render (it is what scroll-into-view fetches
  — composes with [lazy-load-media](lazy-load-media.md)); load the **full** only
  on an explicit tap. Track preview vs full state per attachment. When there is
  no `preview`, behave exactly as today (load the full).
- `MediaAttachment` ([MediaAttachment.tsx](../web/src/components/MediaAttachment.tsx)):
  render the preview blob (blur-up) sized via `width`/`height` (no reflow); a tap
  triggers the full fetch and swaps to it. The full-fetch trigger is a prop
  callback (no hooks in the component — see [CONTRIBUTING.md](../CONTRIBUTING.md)).

### 3. Deletion — sweep both objects

Generalize the delete path from one URL to the message's object set: delete
`file.url` **and** `file.preview.url` (when present). This is the permanent
multi-object delete that Phase 2 later generalizes to N attachments — not a
throwaway. Update the v0.1 amendment behavior in the spec accordingly (or note it
in the v0.2 multipart section, which already states delete sweeps the full set).

## Verify

- `make lint test` — passes; architecture lint passes (component stays hook-free;
  full-fetch is a prop callback).
- Unit: threshold logic (preview made above / skipped below); `sendMedia` uploads
  two objects above the threshold, one below; delete issues `DELETE` for both URLs.
- `useMedia` test: with a `preview`, the in-chat load fetches the preview URL, and
  the full URL is fetched only after the tap trigger; without a `preview`, the full
  is fetched as before.
- `MediaAttachment.stories.tsx` — preview-loaded, full-loaded, and below-threshold
  (no-preview) states; light + dark.
- `pnpm tsc && pnpm build` (gate skips these).
- Manual on a throttled link: open a chat with large photos → previews appear in
  ~a moment, not after multi-100-KB downloads; tap → full loads; delete a photo →
  both objects gone (verify usage drops by both); a small image (below threshold)
  shows directly with no second object.

## Out of scope

- **Offline preview cache** — [media-preview-cache](media-preview-cache.md) (P1c)
  persists these previews in IndexedDB.
- **Receiver-side thumbnail for preview-less images** — also P1c (it reuses
  `reencodeImage` on the downloaded full).
- **Albums / `attachments[]`** — Phase 2.
