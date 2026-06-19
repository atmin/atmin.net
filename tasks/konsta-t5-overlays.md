# Konsta migration T5 — global overlays

> Part of the **Konsta UI migration** ([ADR-0023](../docs/decisions/adr-0023-konsta-ui.md)).
> Needs **T0**; can interleave any time after it (cross-cutting chrome).

## Goal

Move the app-level overlays/notifications to Konsta so they match the native
feel and theme with the rest.

## Scope (files)

- `web/src/components/OfflineIndicator.tsx`
- `web/src/components/SWUpdateToast.tsx`
- `web/src/components/RestoreWarningToast.tsx`
- `web/src/components/NotFound.tsx`
- Any remaining confirm dialogs not already moved with their screen.
- Wiring lives in `routes/app.tsx` (the overlay slot) — keep the gating rules
  (only one bottom overlay at a time; offline > update).

## Konsta components (catalog)

`Notification`/`Toast` (SW update, restore warning), a status banner or `Toast`
(offline), `Dialog`/`Sheet` (confirms), `Page`/`Block` (NotFound). Keep the
existing `localStorage` dismiss flags and the SW-update reload flow.

## Storybook

Rewrite `OfflineIndicator`, `SWUpdateToast`, `RestoreWarningToast` stories for
Konsta × ios/material × light/dark.

## e2e

Touch points are light (toasts are mostly visual); confirm the SW-update reload
and offline-banner flows still behave if covered.

## shadcn retired

`alert` (used by toasts/banners) — drop locally once unreferenced.

## Done when

- Overlays are Konsta and theme-consistent; gating preserved; dismiss/reload
  flows intact; stories updated; gates green.

> Directional/back **page transitions** are **not** here — they ride with the
> optional data-router task (ADR-0023 / README parked list). T5 is overlays only.
