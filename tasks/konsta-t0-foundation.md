# Konsta migration T0 — foundation: shell, theming, Storybook harness

> Part of the **Konsta UI migration** ([ADR-0023](../docs/decisions/adr-0023-konsta-ui.md)).
> **Blocks T1–T6** — nothing else can use Konsta components until the provider +
> theme + Storybook decorator exist. No screen is redesigned here; existing
> shadcn screens keep rendering unchanged inside the new shell.
>
> Lift the proven bits from branch **`konsta-spike`** (don't reinvent): the
> `index.css` import, `useKonstaTheme`, `useViewTransitionNavigate`.

## Goal

Stand Konsta up as the app's UI shell and theme context, wire platform-based
theme selection + the View-Transition nav helper, and give Storybook an
iOS/Material toggle — so every later task can build screens in the right context.

## Scope (files)

- **`web/src/index.css`** — `@import "konsta/react/theme.css"` after the
  tailwindcss import. **Trim the barrel**: import only the sub-styles we use
  (base, colors, ios-material, hairlines, safe-areas, touch-ripple) rather than
  the full theme.css (it also pulls glass/preloader/range) — the ADR's bundle
  note. Measure the CSS delta.
- **`web/src/routes/app.tsx`** — wrap the tree in Konsta `<App theme={theme} dark
  safeAreas>` (outside `<BrowserRouter>`). T0 adds the **provider/theme context
  only** — Konsta `Page` is introduced **per-screen** in T1+, so existing
  `Layout`/`PageContent` screens render unchanged. `dark` composes with the
  existing `.dark` class.
- **`web/src/hooks/useKonstaTheme.ts`** (lift) — theme = Apple→`ios`, else
  `material`, via `Capacitor.getPlatform()` / Tauri OS plugin / UA. Web/UA path
  now; native-shell detection slots in when those shells land.
- **`web/src/hooks/useViewTransitionNavigate.ts`** (lift) — the manual
  `startViewTransition` + `flushSync(navigate)` wrapper; the nav helper screens
  route through for forward transitions. (Directional/back transitions are the
  optional data-router task — see ADR-0023 / README parked list.)
- **`web/package.json`** — add `konsta` (first real consumer; the dep lands on
  master here).
- **`web/.storybook/preview.tsx`** — add a Konsta `<App>` decorator + a
  `globalTypes` toolbar to switch `ios`/`material`, alongside the existing
  `MemoryRouter` + `withThemeByClassName` (light/dark). This is the harness every
  later task's stories depend on.

## Decisions to make here

- Trim list for `theme.css` sub-imports (record what's dropped + the saving).
- Confirm `<App>` at the root doesn't disturb shadcn screens (it shouldn't —
  it's a themed `div` + context); `Page` stays per-screen.

## Storybook

The decorator + ios/material toolbar is the deliverable. Verify one trivial
Konsta component (e.g. a `Button` story) renders correctly in all four
combinations (ios/material × light/dark).

## Done when

- App boots wrapped in Konsta `<App>`; theme auto-selects by platform with a
  manual override; existing screens look unchanged.
- Storybook shows the ios/material toggle and a sample Konsta component renders.
- `make fmt lint` (incl. architecture lint), `pnpm tsc`, `pnpm build` green;
  CSS/JS bundle delta recorded.
