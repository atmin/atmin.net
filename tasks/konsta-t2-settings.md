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

`Page`, `BlockTitle`, `List`/`ListItem`/`ListInput`/`ListButton`, `Toggle` (photo
quality / per-row settings), `Dialog` or `Sheet` (delete-account confirm, change
-password), `Progressbar` (storage usage), `Badge`. Consider grouped insets per
settings section.

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
