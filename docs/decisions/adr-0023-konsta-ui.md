# ADR-0023: Konsta UI for cross-platform native feel

Date: 2026-06-19
Status: Draft
Amends: [ADR-0003](./adr-0003-ui-component-framework.md) (the component-framework
choice for the mobile/native-feel UI; shadcn's other premises stand — see below)
Relates to: [v0.2.md](../specs/v0.2.md) (client-UX direction),
[evolution/native-apps.md](../evolution/native-apps.md) (the Capacitor/Tauri
targets this serves), [ADR-0004](./adr-0004-sse-realtime-notifications.md) (RR
routing context). Evidence: branch `konsta-spike` (preserved) and its findings.

## Context

[ADR-0003](./adr-0003-ui-component-framework.md) chose shadcn/ui (Radix +
Tailwind) and it was the right call for v0.1: an accessible, Tailwind-coherent
web UI, shipped fast, with the components a messenger needs (dialogs, inputs,
menus).

v0.2 changes the goal. The client targets three runtimes — mobile (Capacitor),
desktop (Tauri, a tray-anchored tall window), and web — and wants a **native
feel**: iOS styling on Apple platforms, Material elsewhere. shadcn is a generic
web/desktop design system, not a platform-adaptive iOS/Material chrome.
Delivering native feel on shadcn means hand-building both platform looks — i.e.
reinventing a mobile UI kit.

Constraints carried from ADR-0003 that any answer must respect: **keep Tailwind
v4** (no parallel styling system), **keep the lightweight-bundle stance**, keep
the layered architecture, and keep the existing declarative React Router.

## Decision

Adopt **Konsta UI** — a Tailwind-native iOS/Material component kit — as the
native-feel chrome for v0.2, **migrating incrementally** off shadcn.

- **Incremental, chrome-first.** Replace navbars, lists, sheets, and inputs with
  Konsta screen by screen. shadcn and Konsta coexist during the transition;
  shadcn is retired per-screen as Konsta replaces it, and may remain for bespoke
  or desktop-only surfaces. No big-bang rewrite — this is the "replace components
  one at a time, no lock-in" property ADR-0003 already relied on.
- **Theme rule.** iOS on Apple platforms (iOS + macOS), Material everywhere else,
  via Konsta's `App theme` prop fed by platform detection (`Capacitor.getPlatform()`
  / Tauri OS plugin / UA), kept in a hook per the layered-arch rules.
- **Motion via the View Transitions API, not a framework.** Page transitions are
  layered on top. React Router's built-in `viewTransition` option is inert under
  our declarative `<BrowserRouter>` (it is a data-router feature), so we drive
  `document.startViewTransition` + `flushSync(navigate)` directly in a small hook.
  Migrating to the data router to get RR's built-in support is the alternative;
  the manual wrapper is the default because it keeps the router untouched.
- **Tailwind v4 stays.** Konsta 5 is Tailwind-v4-native — a single
  `@import "konsta/react/theme.css"` (its `@source` scanning + `k-ios`/`k-material`
  custom-variants), no `tailwind.config.js`, no `@config` bridge, no downgrade.

This **amends** ADR-0003 rather than superseding it: the virtualization decision
(`@tanstack/react-virtual` for the message list) is unaffected, and ADR-0003's
principles — Tailwind stays, own the code, no lock-in, lightweight bundle — all
hold; only the component library for the native-feel chrome changes.

### Evidence (spike — branch `konsta-spike`)

- **Tailwind v4 (the kill risk): resolved** with the one-line CSS import above.
- **Bundle delta: ~+24 kB gzip** for the first screen (+13 kB JS tree-shaken,
  +11 kB CSS). The CSS is mostly **one-time** (Konsta's theme base) and reducible
  by importing only the sub-styles used. Within the lightweight stance for a full
  UI kit; well under Framework7/Ionic.
- **Themes and web/responsive: confirmed**; iOS+Material × light/dark render
  correctly, across browsers and narrow→wide widths.

## Consequences

### Positive

- Native iOS/Material feel across all three runtimes, from one Tailwind codebase.
- Tailwind, the layered arch, and the router are all preserved.
- Konsta is just Tailwind classes + thin React wrappers, so it composes with
  plain Tailwind and coexists with shadcn — the migration is incremental and
  reversible, no lock-in.

### Negative / costs

- Two component systems coexist during the migration (transient).
- Bundle grows (~+24 kB gzip first screen, as above) — acceptable, but recorded.
- With the manual View-Transition wrapper, transitions are wired per navigation;
  **directional / back transitions** (reverse the slide on POP) are follow-up.
- e2e selectors change as screens migrate to Konsta DOM — specs need updating
  per screen.

### Neutral / follow-up

- shadcn is not deleted wholesale; it stays until replaced (and possibly for
  desktop-only surfaces).
- **Device-gated verification remains:** the Capacitor and Tauri shells, and
  WKWebView (iOS Safari) View Transitions support, are unverified on hardware —
  to be checked during the migration, not a gate on this decision (Konsta renders
  in the same WebView engines already tested in-browser).
- Next step is an **incremental migration task** (chrome-first, screen by screen)
  and wiring theme detection to the native platform APIs.

## Alternatives considered

- **Stay on shadcn, hand-build iOS/Material variants** — reinvents a platform UI
  kit; defeats the point. Rejected.
- **Framework7** — owns its own router and ships a non-Tailwind styling system;
  heavier. An "exoskeleton" that would replace the router and Tailwind. Rejected.
- **Ionic** — adaptive components + a navigation shell, but the shell is
  React-Router-coupled (older RR) and its components are CSS-variable themed, not
  Tailwind. Same Tailwind-coherence cost as Framework7, milder. Rejected, but
  **noted as the fallback**: if a batteries-included native-navigation shell is
  later wanted, Ionic's shell + Konsta components (`theme="parent"`) is the path.
- **Data router + RR built-in View Transitions** — a cleaner motion story but a
  routing migration; deferred in favor of the manual wrapper.
