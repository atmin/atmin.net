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
the reference prototype + findings.

**T0 (foundation) has landed** — Konsta `<App>` shell (provider + platform theme
context) + `useKonstaTheme` detection + `useViewTransitionNavigate` helper + the
Storybook ios/material harness; existing shadcn screens render unchanged inside
it. Foundation bundle cost over baseline, trimmed `theme.css` (drops
glass/preloader/range/no-scrollbar): **+9.6 kB gzip CSS, +0.8 kB gzip JS** (the
full barrel would be +10.6 kB CSS — the trim saves ~1 kB; CSS is mostly one-time
`@source`-generated Konsta classes). T6 does the final measurement once all
screens migrate. Remaining work proceeds risk-ascending; T6 last.

**T1 (conversation list) has landed** — `ChatsView` rebuilt as a Konsta
`Page`/`Navbar`/`List`; `atmin` wordmark carries the `serverOk` dot, a compose
action opens a `Sheet` for new chats, and the gear navigates to Settings. The
handle card moved to Settings (already there) and sign-out moved into the
(still-shadcn) Settings screen. Per-screen JS cost: **~+12 kB gzip** (the Konsta
component runtime; CSS unchanged — classes were scanned in T0).

**T2 (settings) has landed** — Settings is now one scrolling Konsta `Page` of
grouped inset `List` sections (`settings.tsx` owns the Page + back `Navbar`;
`ProfileSettings` is just the profile section). Change-password and
delete-account are `Sheet`s, device-revoke is a `Dialog`, photo-quality is a
checkmark radio-list, storage gains a `Progressbar`, sign-out is a red
`ListButton`. The sign-out parked by T1 is now restyled in Konsta. Shared
`PasswordInput`/`PasswordStrengthMeter` reused inside the sheets (T3 migrates
auth). Per-screen JS cost: **~+3 kB gzip** (new Konsta components, partly offset
by dropping shadcn `Card`/`Checkbox`/`Button` here; CSS flat).

1. **[konsta-t3-auth](konsta-t3-auth.md)** — landing / login / register; **kills
   AuroraBackground**.
2. **[konsta-t4a-chat-chrome](konsta-t4a-chat-chrome.md)** — chat navbar +
   `Messagebar` composer (preserves the compose tray).
3. **[konsta-t4b-chat-timeline](konsta-t4b-chat-timeline.md)** — message bubbles
   (`Messages`/`Message`) + media + edit/delete; needs T4a.
4. **[konsta-t5-overlays](konsta-t5-overlays.md)** — toasts / indicators /
   dialogs (can interleave any time now T0 is done).
5. **[konsta-t6-cleanup](konsta-t6-cleanup.md)** — retire dead shadcn, final
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
