# Konsta migration T4a — chat screen: chrome + composer

> Part of the **Konsta UI migration** ([ADR-0023](../docs/decisions/adr-0023-konsta-ui.md)).
> Needs **T0**; do **after T1–T3** (heaviest screen, on proven patterns). The
> chat screen is split: **T4a = chrome + composer**, [T4b](konsta-t4b-chat-timeline.md)
> = the message timeline. T4a first (T4b renders inside this shell).

## Goal

Rebuild the chat screen's frame — navbar, scroll container, and the **compose
tray** (the pick/paste/drop + companion-message + Send flow shipped in
`media-compose-tray`) — using Konsta, **`Messagebar`** as the composer.

## Scope (files)

- `web/src/components/ChatView.tsx` — the shell: `Page`, `Navbar` (back +
  title/handle), the messages scroll region (hand off rows to T4b), and the
  composer. **Preserve** the compose-tray behavior: staged attachment thumbnail/
  chip, paste/drop handlers, caption, Send-enabled logic, offline/sending states.
- `web/src/components/BackButton.tsx` → Konsta `NavbarBackLink`.
- `web/src/components/JumpToBottomButton.tsx` → Konsta `Fab` (or keep custom);
  keep the `useChatScroll` contract.
- `web/src/routes/chat.tsx` — back nav through `useViewTransitionNavigate`.

## Konsta components (catalog)

`Page`, `Navbar` + `NavbarBackLink`, **`Messagebar`** (text + attach + send;
map the compose tray's staged-item preview into the Messagebar's sheet/area),
`Fab` (jump-to-bottom). Decide how much to customize `Messagebar` vs. wrap it —
you lean to Konsta's Messages family; settle the customization depth here.

## Architecture watch

`ChatView` is a `components/` file — no `useEffect`/`useRef`; paste/drop stay
inline handlers (as today), staging/lifecycle stays in the route hooks
(`useComposeAttachment`). Keep that boundary.

## Storybook

Rewrite the `ChatView` stories' **chrome/composer** parts (empty, text-only,
staged-image, staged-file, offline, sending). Timeline-heavy stories move with
T4b. ios/material × light/dark.

## e2e

`first-conversation`, `compose.spec.ts`, `offline-mode`, `media.spec.ts` (the
`Type a message...` placeholder, attach input, Send button, compose-tray testids)
— preserve testids where cheap, else update.

## Done when

- Chat chrome + composer are Konsta with `Messagebar`; compose tray (paste/drop/
  caption/Send) and offline/sending states all work; back nav transitions;
  chrome stories updated; compose/first-conversation e2e green; gates green.
