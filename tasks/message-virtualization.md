# Virtualize message list with @tanstack/react-virtual

> **Status: parked.** Pick this up only when there is evidence of real perf
> degradation (jank on a real device, not a synthetic benchmark). The
> scroll-to-bottom prerequisite has already landed in
> [useChatScroll.ts](../web/src/hooks/useChatScroll.ts). See
> [tasks/README.md](README.md) for priority.

## When to pick this up

[adr-0003-ui-component-framework.md:23-24](../docs/decisions/adr-0003-ui-component-framework.md)
gates virtualization on "rendering 1000+ messages efficiently."

Concrete triggers (any one is sufficient):

- A real user reports scroll jank in a chat ≥ ~500 messages on a mid-tier
  Android device.
- The Chrome DevTools performance panel shows >16 ms layout/paint on
  message-list updates with our current message volume.
- Memory usage with all messages mounted is meaningfully (≥30 %) above a
  virtualized baseline measured on the same data.

Without one of these, the plain `messages.map` is correct and cheaper than
the virtualization complexity (see "non-trivial sub-problems" below).

## Prerequisites

- The scroll-anchor hook ([useChatScroll.ts](../web/src/hooks/useChatScroll.ts))
  has already landed. It is the integration point that virtualization
  plugs into — naïve virtualization without it makes the open-at-oldest
  bug worse, because the translated absolute-positioned inner container
  doesn't even have a useful default `scrollTop`.

## Current state

- [ChatView.tsx:59-97](../web/src/components/ChatView.tsx) — plain scroll
  container with `messages.map((msg) => <ChatMessage ... />)`. Every
  message in the DOM.
- `@tanstack/react-virtual` is not installed. Verified absent from
  [web/package.json](../web/package.json).
- `ChatView` already receives a callback ref + indicator props from
  [useChatScroll](../web/src/hooks/useChatScroll.ts). This task replaces
  the inner render branch but keeps that contract.

## Non-trivial sub-problems

These are the reasons this is bigger than "install and replace":

1. **Architecture rules.** [lint-architecture.sh](../web/scripts/lint-architecture.sh)
   forbids `useEffect`/`useCallback`/`useMemo`/`useRef` in `components/`.
   `useVirtualizer` requires a ref for the scroll parent and typically
   `useMemo` for derived ranges. Resolution: a new
   `web/src/hooks/useVirtualMessageList.ts` hook owns the virtualizer.
   The hook is called from `routes/chat.tsx` alongside `useChatScroll`
   (they need to coordinate — see point 5). The hook returns a virtual-row
   list, a `getTotalSize()`, and a callback ref that *replaces* the raw
   scroll callback ref from `useChatScroll`.

2. **Variable row heights.** Text messages vary in length; media messages
   are tall. Use `useVirtualizer`'s built-in `measureElement` —
   `virtualizer.measureElement` must be wired to each row's outer element
   via `ref` and `data-index`.

3. **Media height changes after load.** A `ChatMessage` with a media
   placeholder grows when the blob decrypts and renders. The
   `measureElement` mechanism handles this **only** if the row outer
   element itself resizes; verify by using a `ResizeObserver` on the row
   wrapper, or by calling `virtualizer.measureElement(el)` after
   `mediaState` transitions to `ready`. Test this explicitly — it is the
   single most likely regression.

4. **Initial scroll position is at the top by default.** A fresh
   virtualizer opens at index 0. The scroll-to-bottom hook handles this
   by jumping `scrollTop` to `scrollHeight`, but on a virtualized list
   `scrollHeight` is `getTotalSize()` and the bottom rows aren't
   measured yet, so the first jump can land short of the true bottom.
   Resolution: after the initial measurement pass, call
   `virtualizer.scrollToIndex(messages.length - 1, { align: 'end' })`,
   then re-run on the next animation frame until `scrollTop` stabilises.

5. **Coordination with `useChatScroll`.** The scroll-anchoring contract
   (open at bottom; stick at bottom unless user scrolled up; show
   indicator) needs to work in virtualized mode. Two clean options:
   - **(a) Rewrite `useChatScroll` internals** to call
     `virtualizer.scrollToIndex(last, { align: 'end' })` instead of
     `el.scrollTop = el.scrollHeight`. The hook's public contract
     (callback ref, `showJumpToBottom`, `jumpToBottom`) is unchanged;
     the route still calls both hooks but passes the virtualizer
     instance down. **Preferred** — keeps the contract stable.
   - **(b) Merge the two hooks** into `useVirtualChatScroll`. Simpler
     internally but creates a wider surface in the route. Rejected
     unless (a) becomes unwieldy.
6. **Anchored-bottom heuristic.** Reuse the existing 64 px slack from
   `useChatScroll`. With virtualization, `scrollHeight - scrollTop -
   clientHeight` is computed against the virtualizer's `getTotalSize()`,
   which depends on `measureElement` — values are correct only after
   measurement. Worth a defensive test for the case where the user
   scrolls right after open before all rows are measured.

7. **Loading and empty branches do not virtualize.** Keep the existing
   `loading ? ... : messages.length === 0 ? ... : <virtualized list>`
   structure. Only the populated branch changes.

8. **Storybook visual divergence.** Existing stories
   ([ChatView.stories.tsx](../web/src/components/ChatView.stories.tsx))
   continue to render the same messages, but the inner DOM goes from
   "list of children" to "absolutely-positioned children inside a
   `translateY` wrapper of fixed `getTotalSize()` height." Any visual
   snapshot tooling will need to be re-baselined — flag this in the PR.

## Change

### 1. Install the dep

```sh
cd web && pnpm add @tanstack/react-virtual
```

(The repo is pnpm-only — see [Makefile](../Makefile) and
[CONTRIBUTING.md](../CONTRIBUTING.md) "Setup". Do not use `npm`.)

### 2. `web/src/hooks/useVirtualMessageList.ts` — new hook

API sketch:

```ts
import { useVirtualizer, type Virtualizer } from '@tanstack/react-virtual';
import { useRef } from 'react';
import type { Message } from './useChat';

interface VirtualMessageList {
    setScrollEl: (el: HTMLDivElement | null) => void;
    virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement>;
    items: ReturnType<Virtualizer<HTMLDivElement, HTMLDivElement>['getVirtualItems']>;
    totalSize: number;
}

export function useVirtualMessageList(messages: Message[]): VirtualMessageList {
    const elRef = useRef<HTMLDivElement | null>(null);

    const virtualizer = useVirtualizer({
        count: messages.length,
        getScrollElement: () => elRef.current,
        estimateSize: () => 80, // average message row; refined by measureElement
        getItemKey: (i) => messages[i]?.id ?? i,
        overscan: 8,
    });

    const setScrollEl = (el: HTMLDivElement | null) => {
        elRef.current = el;
    };

    return {
        setScrollEl,
        virtualizer,
        items: virtualizer.getVirtualItems(),
        totalSize: virtualizer.getTotalSize(),
    };
}
```

Return the `virtualizer` instance so `useChatScroll` can call
`scrollToIndex` (per option 5a above).

### 3. Update `web/src/hooks/useChatScroll.ts`

Accept an optional `virtualizer` argument; when provided, replace direct
`scrollTop = scrollHeight` writes with
`virtualizer.scrollToIndex(messageCount - 1, { align: 'end' })`. Keep the
public return shape (`setScrollEl`, `showJumpToBottom`, `jumpToBottom`)
unchanged so the component contract is stable.

Re-run the existing
[useChatScroll.test.ts](../web/src/hooks/useChatScroll.test.ts) cases
plus new cases for the virtualized branch.

### 4. `web/src/components/ChatView.tsx` — virtualized rendering

In the populated branch only:

```tsx
<div
    ref={scrollContainerRef}
    className="flex-1 overflow-y-auto"
    style={{ position: 'relative' }}
>
    <div
        style={{ height: totalSize, position: 'relative' }}
        className="mx-auto max-w-2xl px-4 pb-4 pt-14"
    >
        {items.map((item) => (
            <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    right: 0,
                    transform: `translateY(${item.start}px)`,
                }}
            >
                <ChatMessage
                    text={messages[item.index].text}
                    timestamp={messages[item.index].timestamp}
                    sent={messages[item.index].sent}
                    media={messages[item.index].media}
                    mediaState={
                        messages[item.index].media
                            ? mediaStates[messages[item.index].media!.url]
                            : undefined
                    }
                    onMediaRetry={onMediaRetry}
                />
            </div>
        ))}
    </div>
</div>
```

ChatView accepts new props: `items`, `totalSize`, `virtualizer`. Pass them
through from the route. Loading and empty branches are unchanged.

### 5. `web/src/routes/chat.tsx` — wire both hooks

```ts
const vlist = useVirtualMessageList(messages);
const scroll = useChatScroll(messages, handle ?? '', vlist.virtualizer);
// ...
<ChatView
    // ...existing props...
    scrollContainerRef={(el) => {
        scroll.setScrollEl(el);
        vlist.setScrollEl(el);
    }}
    showJumpToBottom={scroll.showJumpToBottom}
    onJumpToBottom={scroll.jumpToBottom}
    items={vlist.items}
    totalSize={vlist.totalSize}
    virtualizer={vlist.virtualizer}
/>
```

Both hooks need the same DOM element — combine the callback refs in the
route. Order doesn't matter; the element is the same.

### 6. Media-resize verification

In `useMedia` (or wherever `mediaState` transitions to `ready`), after
the blob is rendered, call `virtualizer.measureElement(rowEl)` for the
affected row to force re-measurement. The cleanest hook for this is to
add a `ResizeObserver` inside the row's wrapper effect, but lifecycle
belongs in a hook, not a component — defer the exact mechanism to
implementation but **test it explicitly**.

### 7. Tests

| Layer | Test | Where |
|---|---|---|
| Hook unit | `useVirtualMessageList` returns items covering the visible range; `totalSize` updates with `count` | `useVirtualMessageList.test.ts` |
| Hook unit | `useChatScroll` (virtualized variant) uses `scrollToIndex(last, end)` and not raw `scrollTop` when virtualizer is passed | extend `useChatScroll.test.ts` |
| E2E | Open a chat with 500+ messages; assert (a) opens at last message, (b) DOM contains far fewer than 500 message nodes (e.g. < 50), (c) scrolling up reveals earlier rows correctly, (d) sending a message lands at bottom | new Playwright spec or extension of an existing one |
| E2E | Inbound media message extends row after blob loads; subsequent rows shift correctly | same spec |

### 8. Bundle size check

After `pnpm build`, inspect the gzipped chunk sizes (Vite prints them).
Document the delta in the PR description. ADR-0003 estimates ~5 kB. If
the actual cost is materially higher, mention it — the lightweight-bundle
constraint is a stated project goal.

## Out of scope

- **Two-way infinite scroll** (lazy-load older messages from S3 archive
  on scroll-to-top). Useful eventually but a separate task — requires
  archive pagination support.
- **Jump-to-message** (deep links, reply-to). No deep links exist; revisit
  with that feature.
- **Sticky date dividers** between messages. Not present today; out of
  scope unless explicitly added later.
- **Reverse-render trick** (column-reverse). `@tanstack/react-virtual`
  doesn't need it; explicit `scrollToIndex(last, end)` is cleaner.

## Verify

- `make lint test` — passes; hook unit tests pass; architecture lint
  passes.
- Storybook re-baselined; `WithMessages` story renders correctly in
  light/dark mode (visual snapshot diff is expected — flag in PR).
- `make e2e-local SPEC=...` — new virtualization spec passes; existing
  chat scenario tests still pass.
- Manual on a real device (preferred mid-tier Android):
  1. Open a chat with 500+ messages → smooth scroll, opens at newest.
  2. Inspect DevTools Elements panel → row count is small (overscan + visible).
  3. Scroll up by 200 messages, then back down → no flicker, positions
     stable, indicator transitions consistent with `useChatScroll`'s
     contract.
  4. Receive a new message while at bottom → auto-scrolls.
  5. Receive while scrolled up → indicator appears; click → jumps to
     bottom.
  6. Receive an inbound media message → row resizes when the blob loads;
     surrounding rows reflow without jumping the user's view.
- Bundle delta documented in the PR.
