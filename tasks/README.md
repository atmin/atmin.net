# Tasks

Active implementation tasks, grouped by milestone and in priority order.
Delete a file once its change lands.

## MVP v0.1 — complete ✅

The baseline E2E messenger is done and frozen — full surface in
[mvp-v0.1.md](../docs/specs/mvp-v0.1.md).

## MVP v0.2 — group chats & reach

Scope is still firming up — see [v0.2.md](../docs/specs/v0.2.md).
Group chats are the headline (not yet broken into task files). **Background
delivery (push) is no longer a v0.2 item** — Web Push was dropped
([ADR-0015](../docs/decisions/adr-0015-web-push.md), Deprecated) and both
background delivery and iOS reach move to the native-apps track
([evolution/native-apps.md](../docs/evolution/native-apps.md)), which gets its
own task/ADR when native is committed.

### Media — Phase 1 landed; Phase 2 (albums) next

Lazy-load of chat attachments and all of **Media Phase 1**
([ADR-0022](../docs/decisions/adr-0022-multipart-media.md)) have **landed**,
each additive on the v0.1 single `file` (no schema break):

- lazy fetch + decrypt on scroll-into-view; non-images are click-to-fetch chips;
- optimized-by-default send + EXIF strip (original-quality opt-out in Settings);
- conditional ~50 KB JPEG preview shown first, full fetched on tap;
- compose tray — stage one attachment (pick / paste / drop) + companion
  message, explicit Send ([compose scenario](../docs/scenarios/compose.md));
- local media cache — decrypted previews cached in IndexedDB for offline
  browsing.

The next media chunk is **Phase 2 — albums** (`attachments[]`, multi-select,
per-image captions, grid — the clean schema break), which has no task yet.

### Active tasks

1. **[message-virtualization](message-virtualization.md)** — Replace the message list with `@tanstack/react-virtual`. Park until there is evidence of real perf degradation; the plain map is fine at current message volumes. Now that scroll-to-bottom has landed, the prerequisite is in place. Lazy-load degrades cleanly under it — an unmounted row is never observed.
