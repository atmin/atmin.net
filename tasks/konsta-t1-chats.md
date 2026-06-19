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

`Page`, `Navbar` (handle/title + status + Settings), `List`/`ListItem` (saved +
DM rows with `media` avatar, `after` timestamp, `link`), `Block`/`BlockTitle`,
`ListInput` + `Button` for new-chat. Reconsider the handle card and the
new-chat affordance as native patterns (e.g. a Navbar action / Fab) rather than
porting the shadcn layout verbatim.

## Storybook

Rewrite `ChatsView.stories.tsx` for the Konsta version; verify ios/material ×
light/dark via the T0 toolbar.

## e2e

`helpers.ts` `openChat` (placeholder `Enter a handle...`, the `Chat` button) and
the conversation-row links — preserve the testids/labels or update the helper.

## shadcn retired

Whatever `ChatsView` used (card/button) — drop locally if no longer referenced.

## Done when

- Chats screen is Konsta, themed, redesigned (not a port); stories updated;
  affected e2e green; `make fmt lint`, `pnpm tsc`, `pnpm build` green.
