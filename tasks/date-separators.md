# Timeline date separators

The one remaining [v0.2](../docs/specs/v0.2.md) item — the last thread to round
out the UI revamp before cutting `v0.2.0`. Make the chat timeline legible over
time: a "Today / Yesterday / `<date>`" divider at each day boundary. Client-only,
no protocol surface.

## Spec

[v0.2.md → Timeline date separators](../docs/specs/v0.2.md#timeline-date-separators--the-remaining-v02-item).
A divider precedes the first message of each calendar day (viewer-local). Label:

- same day as now → **Today**
- previous day → **Yesterday**
- same calendar year → e.g. **14 June**
- earlier year → e.g. **14 June 2025**

Grouped/relative timestamps within a day are a nice-to-have, not a gate.

## Current state

- [ChatView.tsx:292-333](../web/src/components/ChatView.tsx) — a flat
  `messages.map((msg) => <ChatMessage … />)` inside a Konsta `<Messages>`. Each
  message already carries `msg.timestamp` (ms epoch); no day grouping anywhere.
- Konsta ships the divider primitive: **`MessagesTitle`** (`konsta/react`,
  verified in `node_modules/konsta/react`) — renders the centered in-stream label
  that pairs with `Messages`/`Message`. No new dependency.
- Date formatting today is only the chat-list relative `timeAgo`
  ([ChatsView.tsx](../web/src/components/ChatsView.tsx)); there is no shared
  calendar-day helper.

## Change

1. **lib** — add a pure day-key + label helper (e.g.
   `lib/timeline.ts`): `dayKey(ts)` (local `YYYY-MM-DD`) and `dayLabel(ts, now)`
   → `Today` / `Yesterday` / `D MMMM` / `D MMMM YYYY`. Colocated Vitest test
   covers the four buckets + the year boundary + a DST/timezone-stable case.
   Pure logic belongs in `lib/` (it must not import from `hooks`/`components`).
2. **ChatView** — walk `messages` in render and inject a `<MessagesTitle>` before
   any message whose `dayKey` differs from the previous one's. Keep it a plain
   in-`map` derivation (no `useEffect`/`useMemo` — components layer rule); the
   list is already ordered oldest→newest. Give the divider a stable testid
   (`day-separator`) for e2e.
3. **Storybook** — extend `ChatView.stories.tsx` with a multi-day fixture so the
   Today/Yesterday/older dividers are a visible spec in both ios/material themes.

Watch the View-Transition / scroll-anchor interaction: dividers are new timeline
rows, so confirm `useChatScroll` still lands at the newest message on open and
that the T4b `.k-message` min-width rules aren't disturbed.

## Verify

- `make fmt lint test` — incl. the new `lib/timeline.test.ts`; architecture lint
  stays green (no JSX in hooks, no side-effect hooks in components).
- `pnpm tsc` + `pnpm build`.
- Storybook (`make web-storybook`): the multi-day `ChatView` story shows correct
  dividers in light/dark × ios/material.
- e2e: a spec (or an extension of an existing chat spec) asserting a `Today`
  divider above messages sent now, and that a back-dated history shows the right
  older-day labels. One Playwright spec per the scenario it backs.
- Real-device pass — the divider reads right on a live cross-client timeline (the
  bar for done), not just green tests.
