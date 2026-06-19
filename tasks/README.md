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

### Konsta UI migration ([ADR-0023](../docs/decisions/adr-0023-konsta-ui.md))

Incremental, chrome-first migration off shadcn to Konsta UI (Tailwind-native
iOS/Material), motion via View Transitions. Each screen is a **redesign**, not a
1:1 port (Konsta kitchen-sink as the catalog); each rewrites its Storybook
stories and updates its e2e selectors. The `konsta-spike` branch (preserved) is
the reference prototype + findings. Do **T0 first** (it blocks the rest); then
risk-ascending; T6 last.

1. **[konsta-t0-foundation](konsta-t0-foundation.md)** — Konsta shell + theme
   detection + View-Transition nav helper + the Storybook ios/material harness.
   Blocks T1–T6; no screen redesigned.
2. **[konsta-t1-chats](konsta-t1-chats.md)** — conversation list (spike already
   prototyped it).
3. **[konsta-t2-settings](konsta-t2-settings.md)** — settings panels (list-heavy;
   proves forms + dialogs).
4. **[konsta-t3-auth](konsta-t3-auth.md)** — landing / login / register; **kills
   AuroraBackground**.
5. **[konsta-t4a-chat-chrome](konsta-t4a-chat-chrome.md)** — chat navbar +
   `Messagebar` composer (preserves the compose tray).
6. **[konsta-t4b-chat-timeline](konsta-t4b-chat-timeline.md)** — message bubbles
   (`Messages`/`Message`) + media + edit/delete; needs T4a.
7. **[konsta-t5-overlays](konsta-t5-overlays.md)** — toasts / indicators /
   dialogs (can interleave after T0).
8. **[konsta-t6-cleanup](konsta-t6-cleanup.md)** — retire dead shadcn, final
   bundle measurement, flip ADR-0023 Draft→Accepted, retire the spike branch.

### Parked / deferred

- **Data-router migration + directional transitions** — optional; the manual
  View-Transition wrapper only covers forward navigations, so the back button
  doesn't transition. Migrating `<BrowserRouter>` → `createBrowserRouter` gives
  RR-native, uniform transitions across all nav entry points (incl. back). Its
  only payoff here is motion; take it up only if back/link transitions become a
  felt gap (rationale in [ADR-0023](../docs/decisions/adr-0023-konsta-ui.md)).
- **[message-virtualization](message-virtualization.md)** — replace the message
  list with `@tanstack/react-virtual`. Park until there is evidence of real perf
  degradation; the plain map is fine at current volumes. (Keep the Konsta
  timeline rows measure-friendly — see T4b.)
