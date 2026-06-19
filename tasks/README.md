# Tasks

Active implementation tasks, grouped by milestone and in priority order.
Delete a file once its change lands.

## MVP v0.1 — complete ✅

The v0.1 baseline is done: a self-contained, self-service E2E messenger
(password credentials, handles, rotation, media, edit/delete, account
deletion, cleanup, storage visibility). The last pieces landed as
message-amendments ([ADR-0014](../docs/decisions/adr-0014-message-amendments.md)),
draft persistence (`useDraft`), the storage indicator (`GET /v1/store/usage`),
data-retention cleanup (`cleanup` subcommand, [ADR-0006](../docs/decisions/adr-0006-data-retention.md)),
and account deletion (Settings → Danger zone, `DELETE /v1/profile`, invariant
[I7](../docs/scenarios/invariants/i7-deletion-races.md)). Registration is
guarded by a memory-hard proof-of-work
([ADR-0020](../docs/decisions/adr-0020-registration-proof-of-work.md),
supersedes ADR-0007).

## MVP v0.2 — group chats & reach

Scope is still firming up — see [v0.2.md](../docs/specs/v0.2.md).
Group chats are the headline. **Background delivery (push) is no longer a
v0.2 item** — Web Push was dropped ([ADR-0015](../docs/decisions/adr-0015-web-push.md),
Deprecated) and delivery moves to the native-apps track ([evolution/native-apps.md](../docs/evolution/native-apps.md)),
which gets its own task/ADR when native is committed.

Lazy-load of chat attachments has **landed**: images fetch + decrypt on
scroll-into-view (`IntersectionObserver`, `rootMargin: 200px`) rather than
all-at-once on open, and non-images render a click-to-fetch metadata chip
instead of eagerly downloading (`useMedia` + `MediaAttachment`). The
in-chat-thumbnail half of the slow-chat-open problem is the Media Phase 1 set
below.

### Media Phase 1 ([ADR-0022](../docs/decisions/adr-0022-multipart-media.md))

Single-image quality, shipped **additively on the v0.1 single `file`** — no
schema break (that is Phase 2, with albums). Do in order; each is shippable and
its code is reused by the next.

**P1a — optimized-by-default send + EXIF strip — has landed**: photos are
downscaled + re-encoded + metadata-stripped by default (≈10× smaller), with an
original-quality opt-out in Settings, and the additive `file` fields
(`mime`/`width`/`height`/`optimized`) ship the canvas re-encode primitive
(`lib/image.ts`) reused below and supply zero-layout-shift dimensions for new
sends.

**P1b — conditional preview + preview-first display — has landed**: images over
the threshold (~100 KB or ~1024 px) carry a separate ~50 KB encrypted JPEG
preview (`file.preview`) shown immediately in-chat; the full is fetched only on
tap (`useMedia` dual-load), and delete sweeps the full object set (full +
preview). Reuses the P1a re-encode primitive (`makePreview`).

**P1d — compose tray — has landed**: picking / **pasting** / dropping an image
**stages** it in a tray next to the text box (one pending item) rather than
sending immediately; a companion message can be typed and the staged item
removed/replaced, then **Send** produces a single media message whose `body` is
the typed text (filename fallback when empty). Additive on the single `file`
(only populates the existing message-level `body`); the same tray is what Phase 2
generalizes to multi-select. Scenario: [compose](../docs/scenarios/compose.md).

**P1c — local media cache — has landed**: decrypted previews (and
below-threshold smalls) are cached in IndexedDB (`media_cache` store, keyed by
S3 URL — write-once, never stale) on first fetch and served from there
afterward, so media history browses offline and survives refresh with no
re-download (`useMedia` read-through). A preview-less image leaves a
receiver-derived ~512 px thumbnail after its one full download. Best-effort: a
miss/eviction re-fetches; the cache is purged on delete and on a server 404,
and `navigator.storage.persist()` is requested once. Full originals are not
cached (deferred v2).

1. **[ios-install-hint](ios-install-hint.md)** — Dismissible banner on iOS Safari pointing users toward "Add to Home Screen." Low effort; iOS has no native install prompt, so without this the PWA is effectively undiscoverable on the platform. (Originally a push-on-iOS prerequisite; that rationale is moot now, but PWA installability has standalone value.)

2. **[message-virtualization](message-virtualization.md)** — Replace the message list with `@tanstack/react-virtual`. Park until there is evidence of real perf degradation; the plain map is fine at current message volumes. Now that scroll-to-bottom has landed, the prerequisite is in place. Lazy-load degrades cleanly under it — an unmounted row is never observed.
