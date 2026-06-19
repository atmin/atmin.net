# Konsta migration T1 — conversation list (chats)

> Part of the **Konsta UI migration** ([ADR-0023](../docs/decisions/adr-0023-konsta-ui.md)).
> Needs **T0**. First real screen — the spike already prototyped it on branch
> `konsta-spike` (`ChatsViewKonsta.tsx`); productionize + refine, don't just
> copy. Pick components from the **Konsta kitchen-sink** catalog.

## Goal

Rebuild the conversation list as a native-feel screen — not a 1:1 port of the
shadcn version. Validate the core List/Navbar patterns the later screens reuse.

## Scope (files)

- `web/src/components/ChatsView.tsx` — rebuild with Konsta; introduce the Konsta
  `Page` for this route (per T0, Page is per-screen).
- `web/src/routes/chats.tsx` — route through `useViewTransitionNavigate` for
  list→chat; drop the spike-only theme toggle.

## Konsta components (catalog)

`Page`, `Navbar`, `List`/`ListItem` (saved + DM rows with `media` avatar,
`after` timestamp, `link`), `Block`/`BlockTitle`, `Sheet` + `ListInput` +
`Button` for new-chat.

## Decisions (pinned)

- **Navbar.** Konsta `Navbar`: title = the `atmin` wordmark with the `serverOk`
  dot beside it (green / red / yellow, plus an `aria-label` — it's color-only
  today). Right slot = a **compose** action then the **Settings gear** (lucide
  `Settings`, not the Konsta `Icon` component — sets the navbar-icon pattern for
  T2+). Drop the standalone `Logo` and the old "Settings" text link. The dot is
  the server-reachability indicator (`serverOk`), distinct from the device
  `useOnlineStatus()` → `OfflineIndicator` overlay, which is unchanged. Gear +
  compose route through `useViewTransitionNavigate`.
- **New chat** = the navbar compose action opening a Konsta `Sheet` with the
  handle `ListInput` + a "Start chat" `Button` — not an inline form, not a Fab.
- **Your handle** lives in Settings only (`ProfileSettings` already renders it +
  Copy). Drop the handle card from the chats screen.
- **Sign out** moves to Settings. It isn't there yet, so T1 adds a minimal
  sign-out to the existing (shadcn) Settings screen and wires `handleLogout`
  through to the Settings route; chats drops it. T2 restyles it in Konsta.
- **Theme** comes from `useKonstaTheme` (platform); drop the spike `Segmented`
  toggle.
- Emoji avatars (📝 saved / 💬 DM) retained for now; show an empty-state line
  when there are no DMs.

## Storybook

Rewrite `ChatsView.stories.tsx` for the Konsta version; verify ios/material ×
light/dark via the T0 toolbar.

## e2e

`helpers.ts` `openChat` must change: it currently fills `input[placeholder="Enter
a handle..."]` and clicks the `Chat` button inline. With the compose-action +
`Sheet`, it now opens the compose action, fills the handle in the sheet, and
clicks "Start chat". Update the helper; keep the conversation-row link
selectors working (or update them).

## shadcn retired

Whatever `ChatsView` used (card/button) — drop locally if no longer referenced.
Note: a small sign-out control is **added** to the still-shadcn Settings screen
here (it leaves chats), to be restyled in T2.

## Done when

- Chats screen is Konsta, themed, redesigned (not a port); stories updated;
  affected e2e green; `make fmt lint`, `pnpm tsc`, `pnpm build` green.
