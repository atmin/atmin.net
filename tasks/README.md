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

1. **[archive-ingest-cache](archive-ingest-cache.md)** — Stop re-downloading and re-decrypting the full message archive on every refresh. The archive sync cursor goes stale on every compaction, so the common path is a cold re-download of history already materialized in IndexedDB — the dominant cold-start cost on slow connections. Client-only; no protocol change. Correctness boundary (don't drop late-keyed messages) is the careful part.

2. **[lazy-load-media](lazy-load-media.md)** — Fetch chat attachments on scroll-into-view instead of all-at-once on chat open. Client-only, no new dependency; the cheap half of the slow-chat-open problem (the in-chat-thumbnail half is the media Phase-1 set below). Pairs naturally with the open-at-bottom scroll behaviour.

### Media Phase 1 ([ADR-0022](../docs/decisions/adr-0022-multipart-media.md))

Single-image quality, shipped **additively on the v0.1 single `file`** — no
schema break (that is Phase 2, with albums). Do in order; each is shippable and
its code is reused by the next.

3. **[media-optimized-send](media-optimized-send.md)** (P1a) — Downscale + re-encode + EXIF-strip photos by default (≈10× smaller, metadata-clean), with an original-quality opt-out. Introduces the canvas re-encode primitive the next two reuse.

4. **[media-preview](media-preview.md)** (P1b) — Conditional ~50 KB encrypted preview shown immediately, full fetched on tap; delete sweeps both objects. The "small in-chat preview" win.

5. **[media-preview-cache](media-preview-cache.md)** (P1c) — Persist decrypted previews in IndexedDB so media history browses offline and survives refresh; receiver-side thumbnail for preview-less images. Best-effort cache (miss re-fetches).

6. **[ios-install-hint](ios-install-hint.md)** — Dismissible banner on iOS Safari pointing users toward "Add to Home Screen." Low effort; iOS has no native install prompt, so without this the PWA is effectively undiscoverable on the platform. (Originally a push-on-iOS prerequisite; that rationale is moot now, but PWA installability has standalone value.)

7. **[message-virtualization](message-virtualization.md)** — Replace the message list with `@tanstack/react-virtual`. Park until there is evidence of real perf degradation; the plain map is fine at current message volumes. Now that scroll-to-bottom has landed, the prerequisite is in place.
