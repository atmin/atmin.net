# Konsta migration T2 — settings

> Part of the **Konsta UI migration** ([ADR-0023](../docs/decisions/adr-0023-konsta-ui.md)).
> Needs **T0**. List-heavy → the cleanest early win; proves forms + dialogs in
> Konsta. Redesign each panel with appropriate components (Konsta kitchen-sink),
> not a 1:1 port.

## Goal

Rebuild Settings as native-feel grouped lists, with the destructive flows as
proper dialogs/sheets.

## Scope (files)

- `web/src/routes/settings.tsx` (Page + section layout)
- `web/src/components/ProfileSettings.tsx`
- `web/src/components/ChangePasswordPanel.tsx`
- `web/src/components/DeleteAccountPanel.tsx`
- `web/src/components/DeviceSettings.tsx`
- `web/src/components/PhotoQualitySetting.tsx`
- `web/src/components/StorageIndicator.tsx`

## Konsta components (catalog)

`Page`, `BlockTitle`, `List`/`ListItem`/`ListInput`/`ListButton`, `Sheet`,
`Dialog`, `Radio`, `Checkbox`, `Progressbar`, `Badge`. Grouped insets per section.

## Decisions (pinned)

- **Layout.** One scrolling Settings `Page` of grouped inset `List` sections with
  `BlockTitle` headers — no iOS-style drill-in tree (the surface is small). The
  route (`settings.tsx`) owns the `Page` + `Navbar` (back link → Chats, title
  "Settings"); `ProfileSettings` stops being the layout wrapper and becomes just
  the profile section. Back nav is a plain navigate (no reverse View Transition —
  directional transitions are the parked data-router task).
- **Heavy flows = Sheets.** Change-password and delete-account each become a list
  row that opens a Konsta `Sheet` with the form (consistent with T1's new-chat
  sheet; everything stays on `/settings`). Progress/`done` states render inside
  the sheet. The verbose delete warning copy is preserved.
- **Revoke device = small `Dialog`.** The per-device revoke confirm (one secret
  field + Confirm/Cancel) is a modal `Dialog`, opened from the device row.
- **Photo quality = radio-style list.** Two `ListItem`s (Optimized / Original)
  with a checkmark on the selected row and the hint as sub-text — keeps the
  per-option guidance (not a single `Toggle`).
- **Storage = `Progressbar` + text** (red past 90%). **Sign-out = red `ListButton`**.
- **Progress covers** stay as lightweight inline status (Tailwind dots) — no
  Konsta `Preloader` (its sub-style was trimmed in T0).
- **Shared `PasswordInput` / `PasswordStrengthMeter` stay** (used by T3 auth too);
  reused inside the Konsta sheets. Preserve existing `data-testid`s to minimise
  e2e churn; specs open the sheet/dialog first.

## Storybook

Rewrite all six panels' stories (`ProfileSettings`, `ChangePasswordPanel`,
`DeleteAccountPanel`, `PhotoQualitySetting`, `StorageIndicator`, + a
`DeviceSettings` story if absent) for Konsta × ios/material × light/dark.

## e2e

`account-deletion-ui.spec.ts`, `credential-rotate-ui.spec.ts`, `profile.spec.ts`,
device specs — update selectors for the new DOM (form fields, the delete
confirm dialog, the rotate flow).

## shadcn retired

`alert`, `card`, `checkbox`, `button` where these panels used them — drop locally
once unreferenced (full removal is T6).

## Done when

- Settings fully Konsta; destructive flows are dialogs/sheets; six stories
  updated; affected e2e green; `make fmt lint`, `pnpm tsc`, `pnpm build` green.
