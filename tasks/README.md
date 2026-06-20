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

**T3 (auth) has landed** — the unauthenticated flow is Konsta. `LandingPage` is
a bare splash (logo, wordmark, tagline, two buttons); **`AuroraBackground` is no
longer used** — the `ui/AuroraBackground.tsx` primitive, its hook, and its story
are now dead code, deleted in T6 with the rest of the dead shadcn. `LoginForm` /
`RegisterForm` are Konsta `Page`s of grouped `Block strong inset` fields reusing
the custom `PasswordInput` (eye toggle) + `PasswordStrengthMeter`; the register
"I understand" ack is a Konsta `Checkbox`. Every long on-device crypto moment
(register derive/PoW, password change, account deletion) now shares one
`StatusCover` built on Konsta `Preloader` — which meant re-adding `preloader.css`
(trimmed out in T0). Per-screen JS cost: **−4 kB gzip** (dropping shadcn
`Card`/`Alert`/`Checkbox`/`Button` from auth outweighs Konsta, already bundled);
CSS **+0.25 kB gzip** (preloader styles). T6 does the final measurement.

**T4a (chat chrome + composer) has landed** — `ChatView` is a Konsta
`Page`/`Navbar` (back + centered mono handle) with the composer rebuilt on Konsta
`Messagebar` (attach + send in its left/right slots; paste/drop/Enter-to-send ride
the bar root since Konsta only forwards `onInput`/`onChange` to the textarea). The
compose tray (staged image/file + caption + Send) and offline/sending states are
preserved with their e2e testids. Konsta React ships no autogrow, so
`useAutogrowTextarea` (route-wired, like the draft) grows the textarea and a scoped
`index.css` rule lets the bar grow with it — controls centre at rest, bottom-align
once it grows. `BackButton` retired (→ `NavbarBackLink`). The message timeline still
renders the existing `ChatMessage` bubbles — T4b converts those. Per-screen JS cost:
**~+1.5 kB gzip** (Konsta `Messagebar`/`Toolbar`/`Glass` + lucide icons + the hook);
CSS **~+0.2 kB gzip** (messagebar layout overrides). T6 does the final measurement.

**T4b (chat timeline) has landed** — the message timeline is Konsta
`Messages`/`Message`, so bubbles now carry the system colours (iOS blue/grey,
Material primary/surface — the bubble width cap is a single tune point in
`ChatMessage`). The per-bubble menu became a native Konsta `Actions` sheet
(Edit / destructive Delete → confirm), lifted to `ChatView` and rendered once
outside the `transform`-ed bubbles (Konsta modals position with `fixed` and
don't portal) and given an explicit iOS frosted surface (the `glass` style was
trimmed in T0). Editing now reuses the composer — Edit loads the body into the
Messagebar with an "Editing message" banner and a Save check; the inline `<input>`
is gone, and `useAutogrowTextarea` regained its `value` dep so the textarea fits a
loaded multi-line message. `MediaAttachment` kept all its lazy/preview/status
logic; a scoped `.k-message > div { min-width: 0 }` rule keeps a wide image (or an
unbreakable log line via `wrap-anywhere`) inside the bubble instead of spawning a
horizontal scrollbar. The now-dead `--bubble-*` tokens were removed. Per-screen
cost vs T4a: **JS ~+1.9 kB gzip**, **CSS ~flat**. T6 does the final measurement.

**T5 (global overlays) has landed** — the app-level overlays are Konsta
`Toast`s: the offline indicator, the SW-update prompt (Reload + dismiss) and the
restore-warning (amber alert icon + Dismiss) are frosted bottom pills with
lucide icons, and `NotFound` is a bare centered Konsta `Page`. iOS draws its
frosted surface from the `glass` style trimmed in T0, so the toasts carry the
explicit frosted recipe from the T4b actions sheet (Material keeps its tonal
surface-5); the now-dead shadcn `alert` primitive is dropped. The overlay slot
in `app.tsx` shows at most one bottom overlay at a time by priority (offline >
restore > update) — they share the same fixed bottom edge — replacing the prior
independent renders that could overlap. Per-screen cost: **JS ~+0.6 kB gzip**
(lucide icons + Konsta `Toast`, partly offset by dropping the plain-div toasts
and `alert`), **CSS ~−0.2 kB gzip** (the frosted classes were already bundled by
T4b). T6 does the final measurement.

1. **[konsta-t6-cleanup](konsta-t6-cleanup.md)** — retire dead shadcn (incl.
   `AuroraBackground`), final bundle measurement, flip ADR-0023 Draft→Accepted,
   retire the spike branch.

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
