# Lazy-load chat media (fetch on scroll-into-view, not on chat open)

Opening a chat eagerly downloads and decrypts **every** media attachment in the
conversation at once — including images far above the fold. On a slow
connection that stalls the whole view behind history the user may never scroll
to. Load each attachment only when it nears the viewport.

This is the cheap, client-only half of the slow-chat-open problem. The other
half — that even one in-view image is the full-resolution original — is the
separate **media preview/thumbnail** task and is explicitly out of scope here.

## Spec

> A chat attachment is fetched and decrypted only when its message scrolls near
> the viewport. On open, the messages visible at the bottom load immediately;
> off-screen history does not load until approached. Already-loaded attachments
> stay loaded for the session (scrolling away does not re-fetch them).

Because the chat opens scrolled to the newest message, "load what's visible"
falls out of an `IntersectionObserver` naturally — the bottom images intersect
on open and load; older ones don't. No special-casing of "recent" messages.

No protocol, server, or storage change. No new dependency (`IntersectionObserver`
is a browser primitive).

**Scope: images only.** Only image attachments are observed/scroll-fetched.
Non-image attachments are **never auto-downloaded** — they render a metadata-only
chip (type icon + filename + size, straight from the payload) and fetch on click.
So the observer wiring applies to images; the `useMedia` fetch on a non-image is
removed entirely, not deferred. Today's code wastefully shows "Loading…" while
the whole file downloads just to render its already-known name + size + link
([MediaAttachment.tsx:40-50](../web/src/components/MediaAttachment.tsx#L40-L50));
this task changes that branch to a payload-only chip with click-to-fetch. (The
chip itself is part of the [adr-0022](../docs/decisions/adr-0022-multipart-media.md)
display rule; this task at minimum stops the eager non-image download.)

**Determining image-ness *before* fetching.** This is the catch: today MIME is
known only **after** download+decrypt (`sniffInlineImageMime(plaintext)`,
[useMedia.ts:62](../web/src/hooks/useMedia.ts#L62)). The payload carries no
content type — `MediaFile` is `{url, key, iv, name, size}`
([media.ts:29-35](../web/src/lib/media.ts#L29-L35)) — so observe-vs-chip cannot
depend on the sniffed MIME. The only pre-fetch signal available without a
protocol change is the **filename extension**. Add a pure helper in `lib/media.ts`:

```ts
// Best-effort, pre-fetch image guess from the filename. The authoritative
// check stays sniffInlineImageMime (post-decrypt); this only decides whether
// to lazy-observe (likely image) or render a click-to-fetch chip (everything
// else). A real content-type in the payload is the ADR-0022/preview task's job.
export function isLikelyImage(name: string): boolean {
    return /\.(jpe?g|png|gif|webp|avif|bmp)$/i.test(name);
}
```

Accepted imperfection: an extensionless or mislabeled image renders as a chip
and fetches on click (correct, just not inline-lazy); a non-image with an image
extension gets observed and, on load, `sniffInlineImageMime` returns `null` so
it falls through to today's download-link branch. Both degrade safely — no lost
or corrupt rendering. The post-fetch sniff remains the source of truth for how
the *loaded* bytes render.

## Current

- [chat.tsx:47-54](../web/src/routes/chat.tsx#L47-L54) collects **all** media in
  the conversation (`messages.flatMap(m => m.media …)`) and hands the full list
  to `useMedia`.
- [useMedia.ts:94-115](../web/src/hooks/useMedia.ts#L94-L115) — the effect fires
  `load()` for every file without a controller, i.e. **eagerly on open**. Each
  `load` ([useMedia.ts:46-92](../web/src/hooks/useMedia.ts#L46-L92)) fetches the
  ciphertext, decrypts, sniffs MIME, and creates an object URL.
- States are keyed by `file.url` in a `Record<string, MediaState>`; statuses are
  `loading | ready | corrupt | unavailable | network-error`
  ([useMedia.ts:11-22](../web/src/hooks/useMedia.ts#L11-L22)). There is **no**
  "not yet requested" state — `load()` sets `LOADING` immediately.
- [MediaAttachment.tsx:17-72](../web/src/components/MediaAttachment.tsx#L17-L72)
  renders from `state`; the outer `<div data-testid="media-attachment">` is
  always present (good — it's a stable observe target).
- Prop threading: route → [ChatView](../web/src/components/ChatView.tsx#L122-L128)
  → `ChatMessage` → `MediaAttachment`, passing `mediaState` + `onMediaRetry`.
  A new per-url observe callback threads the same way.

## Change

### 1. `useMedia` — observe instead of eager-load

Add an `'idle'` status (requested-but-not-yet-loading → render a sized
placeholder, the observe target) and make `load` fire on intersection:

- Hold a single `IntersectionObserver` in a ref. Expose
  `observe(url: string, el: HTMLElement | null): void` for components to attach
  via a `ref` callback. `observe` must be **idempotent and churn-proof** —
  because the leaf's ref is a fresh arrow each render
  (`ref={(el) => observe(url, el)}`), React calls it with `null` then the
  element on **every** render. So `observe` must:
  - ignore `el === null` (the detach half of the churn) — do not `unobserve` on
    it, or the immediate re-attach re-arms a one-shot you already fired;
  - no-op if `url` is already observed on the same element, or has already been
    **triggered** (track a per-url `triggered: Set<string>`; once `load` fires
    for a url it is triggered forever for the session);
  - otherwise `observe(el)` and record it.

  The `files` array gets fresh identity each sync (see the note at
  [useMedia.ts:42-44](../web/src/hooks/useMedia.ts#L42-L44)), compounding the
  per-render churn — the rules above absorb it.
- On intersection (use `rootMargin: '200px'` so images prefetch just before
  entering view; `root: null` is fine — the chat fills the viewport), call
  `load(file)` **once** for that url, then `unobserve` it (one-shot; loading is
  not repeated).
- **Seed every image url to `'idle'` up-front** in the sync effect
  ([useMedia.ts:94-115](../web/src/hooks/useMedia.ts#L94-L115)) — i.e. replace
  the eager `load()` call ([useMedia.ts:98-100](../web/src/hooks/useMedia.ts#L98-L100))
  with `setStates(s => url in s ? s : { ...s, [url]: IDLE })`. Do **not** call
  `load`/set `LOADING` here — that now waits for intersection. Seeding matters:
  the observe target is the `MediaAttachment` div, which only renders once the
  message has a media state ([ChatMessage.tsx:190](../web/src/components/ChatMessage.tsx#L190),
  guarded on `mediaState`). If the state were left absent until "first observed,"
  the element would never mount, so the observer would never fire, so the load
  would never start — a deadlock. Seeding `'idle'` renders the placeholder,
  which is what gets observed. (Only image urls are seeded — non-images are not
  tracked by `useMedia` at all; see "images only" above and §2's chip.)
- **Do not abort or revoke on scroll-away.** Once a load is triggered, let it
  finish and keep the blob for the session. Keep the existing cleanup for files
  that leave the message list entirely (deleted messages) and the unmount
  teardown ([useMedia.ts:101-126](../web/src/hooks/useMedia.ts#L101-L126)).
- **Fallback when `IntersectionObserver` is undefined** (jsdom/happy-dom, SSR):
  eager-load all files, i.e. today's behaviour. This keeps tests and any
  non-browser render path working without mocking the observer everywhere.

`retry()` is unchanged — manual retry on `network-error`.

### 2. `MediaAttachment` — placeholder + observe ref

- Accept a new prop `observe?: (el: HTMLElement | null) => void` (already
  curried to this url by the parent) and attach it to the outer div:
  `ref={observe}`. **Ref callbacks are allowed in `components/`** — this is not
  a hook, so the architecture rule ([CONTRIBUTING.md](../CONTRIBUTING.md)
  "Layered architecture") is not violated. Do **not** introduce `useRef`/
  `useEffect` here.
- Render a placeholder box for `'idle'` (and for an absent state) so the element
  occupies space and is observable. Until the preview task lands we have no
  stored dimensions, so use a modest fixed min-height placeholder (e.g. a
  rounded muted box) — accept that exact-size reservation / no-layout-shift is
  the preview task's job; note it.
- **Branch on `isLikelyImage(name)` first** (the helper from "Spec"). Non-image:
  render the metadata chip (type icon + `displayName` + `formatBytes(size)`) and
  do **not** attach `observe` — non-images are never auto-fetched. The chip's
  click triggers an on-demand load (see §3); while loading show today's
  "Loading…", and on success render the existing download-link branch
  ([MediaAttachment.tsx:40-50](../web/src/components/MediaAttachment.tsx#L40-L50)).
  Image: attach `observe` and render by state as above. So a non-image never has
  an `'idle'` placeholder — only images are observed and seeded.

### 3. Thread `observe` through `ChatView` → `ChatMessage`

Mirror `onMediaRetry`. The hook exposes a per-url accessor; the cleanest stable
form is for `useMedia` to return `observe(url, el)` and for the leaf to call it
from its ref callback: `ref={(el) => observe(msg.media!.url, el)}`. The
idempotent, null-ignoring `observe` (step 1) absorbs the per-render ref churn.

- **Relax the `ChatMessage` render guard.** It currently renders the attachment
  only when a media state exists
  ([ChatMessage.tsx:190](../web/src/components/ChatMessage.tsx#L190):
  `media && mediaState && onMediaRetry`). That must become
  `media && onMediaRetry` (drop `&& mediaState`) — otherwise a non-image (never
  tracked by `useMedia`, so no state) renders nothing, and there is no element
  to observe. `MediaAttachment` already tolerates an absent/idle state (§2).
- **Click-to-fetch reuses the existing loader.** `useMedia`'s `retry(url)`
  already runs `load(file, token)` for a url
  ([useMedia.ts:128-135](../web/src/hooks/useMedia.ts#L128-L135)); thread it to
  the chip's click as well as the `network-error` retry. (Optionally rename the
  exposed accessor to `request(url)` since it now serves both first-load and
  retry — naming only, same body.) For this to work, `useMedia` must still
  receive **all** media (images + non-images) in `files` so `filesRef` can
  resolve a clicked non-image — it just doesn't seed/observe the non-images.

## Verify

- `make lint test` — passes, including `lint-architecture.sh` (no hooks added to
  `components/`; `observe` is a prop + ref callback).
- `media.test.ts` — `isLikelyImage` unit test: true for `.jpg/.jpeg/.png/.gif/
  .webp/.avif/.bmp` (any case), false for `.pdf`, `.txt`, no extension, and a
  bare name.
- `useMedia.test.ts` (new/extended), with a mocked `IntersectionObserver`:
  - On mount, an image file is seeded `'idle'` and `fetchMedia` is **not** called
    until its element intersects.
  - After simulating intersection, `fetchMedia` is called exactly once; status
    goes `idle → loading → ready`. A second intersection / re-render does **not**
    re-fetch (one-shot + triggered-set).
  - The ref callback firing with `null` (detach) then the element (re-attach) on
    a re-render does **not** unobserve-then-refire (churn-proof).
  - Scrolling out after load completes does **not** abort or re-fetch.
  - A non-image file is **not** seeded and **not** observed; `fetchMedia` fires
    only when its loader is invoked directly (click-to-fetch).
  - With `IntersectionObserver` undefined, all image files eager-load (fallback).
  - `retry()`/`request()` still (re-)fetches on `network-error`.
- `MediaAttachment.stories.tsx` is **new** (no stories exist for this component
  today) — cover all states: `idle` (placeholder), `loading`, `ready` (image),
  `corrupt`, `unavailable`, `network-error`, and the non-image **chip**. Verify
  light + dark.
- `pnpm tsc && pnpm build` (the gate skips these).
- Extend the media e2e spec (do not run the full suite locally — it collides
  with the dev MinIO): open a chat with an attachment scrolled out of view,
  assert its `data-status` stays `idle` (no media `store/object` GET) until
  scrolled into view, then transitions to `ready`. Confirm the newest image
  still loads immediately on open.
- Manual on a throttled connection: open a chat with several old images + one
  recent → only the recent (visible) one loads; scrolling up loads the rest on
  approach; scrolling back down does not re-download.

## Out of scope

- **Media previews / thumbnails** — generating a small encrypted preview object
  at send time and a `preview` descriptor in the payload, so the in-chat image
  is tiny and the full-res loads on tap. Separate task; it also supplies the
  real dimensions that turn step 2's placeholder into zero-layout-shift sizing.
- **Virtualization** ([message-virtualization.md](message-virtualization.md)) —
  complementary (it unmounts off-screen rows entirely); lazy-load degrades
  cleanly under it since an unmounted row is never observed.
