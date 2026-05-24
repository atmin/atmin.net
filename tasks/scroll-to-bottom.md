# Scroll-to-bottom in chat view

## Motivation

When a user opens a chat that already has messages, they should see the
**newest** message, not the oldest. Today, [ChatView.tsx](../web/src/components/ChatView.tsx)
renders messages in a `<div className="flex-1 overflow-y-auto">` with no
scroll management, so the browser opens the container at scrollTop = 0 —
the user sees the oldest message and must manually scroll down to find the
conversation they came to see. For a messenger this is broken behaviour.

A few related properties must also hold:

- New message arrives **while the user is at the bottom** → keep them at
  the bottom (auto-scroll).
- New message arrives **while the user has scrolled up** to read history
  → preserve their scroll position; surface an unobtrusive "Jump to latest"
  indicator. Hijacking the scroll while they are reading is worse than the
  current bug.
- The user **sent** a message → always scroll to the bottom to show their
  own message, regardless of prior scroll position.
- Conversation switch (`/alice` → `/bob`) → open the new chat at its
  bottom.
- Window resize / mobile virtual keyboard opens → stay at the bottom if
  previously at the bottom.

This task is a prerequisite for [message-virtualization](message-virtualization.md):
without scroll anchoring, virtualization makes the bug worse (translated
absolute layout doesn't even default to scrollTop = 0 in a useful way).

## Current state

- [ChatView.tsx:59](../web/src/components/ChatView.tsx) — plain
  `<div className="flex-1 overflow-y-auto">`; no `ref`, no scroll handlers,
  no scroll-to-bottom anywhere in `web/src`. Verified via grep for
  `scrollIntoView`, `scrollTop`, `scrollHeight`.
- Messages are sorted oldest → newest in [useChat.ts:170](../web/src/hooks/useChat.ts)
  via the IDB `userId_timestamp` index, so the newest message is the **last**
  child of the scroll container.
- New messages stream in via SSE → IDB → `setMessages` in
  [useChat.ts](../web/src/hooks/useChat.ts); the `messages` array reference
  changes when content changes.
- Conversation switch keeps `ChatRoute` mounted (React Router rerenders with
  new `useParams`); only `handle` and `messages` change.

## Architecture constraints

[lint-architecture.sh](../web/scripts/lint-architecture.sh):
- `components/` may not use `useEffect`/`useCallback`/`useMemo`/`useRef`
  and may not value-import from `@/hooks/`.
- `hooks/` files must be `.ts`.

Therefore: scroll state and DOM access live in a hook called from
`routes/chat.tsx`; the hook returns a **callback ref** plus state and
handlers, which the route passes to `ChatView` as props. `ChatView` stays
presentational.

## Behaviour contract

| Event | Behaviour |
|---|---|
| First render with `messages.length > 0` | Scroll to bottom on the first paint where the container element has non-zero `scrollHeight`. |
| `handle` changes (conversation switch) | Reset "was at bottom" state to `true`; scroll to bottom on next paint. |
| `messages` array changes AND prior scroll state was "at bottom" | Scroll to bottom. |
| `messages` array changes AND user is scrolled up | Do not scroll; set `showJumpToBottom = true`. |
| Last added message has `sent: true` AND its id wasn't in the previous array | Always scroll to bottom (user's own send). |
| User clicks `JumpToBottom` indicator | Scroll to bottom; hide indicator. |
| User scrolls down within ~64 px of bottom on their own | Treat as "at bottom" again; hide indicator. |
| Window resize while "at bottom" | Re-scroll to bottom (keeps anchor through layout changes). |

"At bottom" tolerance: `scrollHeight - scrollTop - clientHeight < 64`. The
slack absorbs sub-pixel rounding and the visual gap between the last
message and the input bar.

## Change

### 1. `web/src/hooks/useChatScroll.ts` — new hook

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from './useChat';

const AT_BOTTOM_SLACK_PX = 64;

interface ScrollState {
    setScrollEl: (el: HTMLDivElement | null) => void;
    showJumpToBottom: boolean;
    jumpToBottom: () => void;
}

export function useChatScroll(messages: Message[], handle: string): ScrollState {
    const elRef = useRef<HTMLDivElement | null>(null);
    const atBottomRef = useRef(true);
    const lastMessageIdRef = useRef<string | null>(null);
    const [showJump, setShowJump] = useState(false);

    const scrollToBottom = useCallback(() => {
        const el = elRef.current;
        if (!el) return;
        el.scrollTop = el.scrollHeight;
        atBottomRef.current = true;
        setShowJump(false);
    }, []);

    // Reset when conversation switches
    useEffect(() => {
        atBottomRef.current = true;
        lastMessageIdRef.current = null;
        setShowJump(false);
        // scroll happens via the messages effect once the new list lands
    }, [handle]);

    // React to message list changes
    useEffect(() => {
        const el = elRef.current;
        if (!el) return;
        const last = messages[messages.length - 1];
        const lastId = last?.id ?? null;
        const isNew = lastId !== null && lastId !== lastMessageIdRef.current;
        const newSelfSend = isNew && last?.sent === true;
        lastMessageIdRef.current = lastId;

        if (atBottomRef.current || newSelfSend) {
            scrollToBottom();
        } else if (isNew) {
            setShowJump(true);
        }
    }, [messages, scrollToBottom]);

    // Stay anchored to bottom across resizes (mobile keyboard, orientation)
    useEffect(() => {
        const onResize = () => {
            if (atBottomRef.current) scrollToBottom();
        };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, [scrollToBottom]);

    const setScrollEl = useCallback(
        (el: HTMLDivElement | null) => {
            elRef.current = el;
            if (!el) return;
            const onScroll = () => {
                const atBottom =
                    el.scrollHeight - el.scrollTop - el.clientHeight <
                    AT_BOTTOM_SLACK_PX;
                atBottomRef.current = atBottom;
                if (atBottom) setShowJump(false);
            };
            el.addEventListener('scroll', onScroll);
            // First paint: jump to bottom if content already present
            if (messages.length > 0) {
                // queueMicrotask ensures children are laid out
                queueMicrotask(() => {
                    el.scrollTop = el.scrollHeight;
                });
            }
            // No teardown stored — the element is recreated on remount, and
            // event listeners attached to a detached DOM node are GC'd.
        },
        [messages.length],
    );

    return { setScrollEl, showJumpToBottom: showJump, jumpToBottom: scrollToBottom };
}
```

Notes:
- `setScrollEl` is a **callback ref** — React invokes it with the element
  on mount and `null` on unmount. We use it to attach the scroll listener
  and do the initial-paint jump in one place.
- Initial-paint jump runs in `queueMicrotask` so the children have been
  laid out and `scrollHeight` is correct. If the messages list grows after
  the ref attaches (typical: empty → loaded), the messages-effect will
  also fire and scroll.
- "Self-send detected by `last.sent && new id`" is the simplest signal
  that doesn't need a new prop wired from `useChatSend`.

### 2. `web/src/hooks/useChatScroll.test.ts` — unit tests

Pattern: happy-dom + `renderHook` + manual DOM construction. Test must
manipulate `scrollHeight`/`scrollTop`/`clientHeight` directly on a real
element (happy-dom layout numbers are zero by default; set them via
`Object.defineProperty` for the test). See
[useOnlineStatus.test.ts](../web/src/hooks/useOnlineStatus.test.ts) for the
file scaffold.

Required cases:

| Test | Setup | Assert |
|---|---|---|
| initial jump to bottom on first attach with messages | mount with 5 messages, attach el, advance microtask | `el.scrollTop === el.scrollHeight` |
| no jump on empty list | mount with `[]` | `el.scrollTop === 0`, `showJumpToBottom === false` |
| new incoming while at bottom | seed at-bottom; append message | `scrollTop` updated to bottom; `showJumpToBottom === false` |
| new incoming while scrolled up | seed user scrolled up (fake scroll event); append message | `scrollTop` unchanged; `showJumpToBottom === true` |
| self-send while scrolled up | seed scrolled up; append message with `sent: true` and a new id | scrolled to bottom; `showJumpToBottom === false` |
| handle switch resets at-bottom + clears indicator | seed scrolled up + indicator showing; rerender with new handle | `showJumpToBottom === false`; new-handle messages cause jump |
| `jumpToBottom()` jumps and clears indicator | seed scrolled up + indicator; call `jumpToBottom()` | `scrollTop` at bottom; indicator cleared |
| scroll into bottom zone clears indicator | seed indicator showing; fire scroll event with scroll position inside slack | `showJumpToBottom === false` |
| window resize while at bottom re-anchors | mount, append message, simulate parent resize with `scrollHeight` increase, fire `resize` | `scrollTop` re-pinned to bottom |

### 3. `web/src/components/ChatView.tsx` — accept scroll props

```ts
interface Props {
    // ...existing...
    scrollContainerRef: (el: HTMLDivElement | null) => void;
    showJumpToBottom: boolean;
    onJumpToBottom: () => void;
}
```

Attach the callback ref to the scroll container; render the
`JumpToBottomButton` when `showJumpToBottom`:

```tsx
<div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
    {/* ...existing children... */}
</div>
{showJumpToBottom && (
    <JumpToBottomButton onClick={onJumpToBottom} />
)}
```

Position the button as a fixed/absolute element just above the input bar,
e.g. `absolute bottom-20 right-4 z-10 rounded-full ...`. Keep it small and
unobtrusive; ↓ arrow icon is enough.

### 4. `web/src/components/JumpToBottomButton.tsx` — new tiny component

```tsx
interface Props {
    onClick: () => void;
}

export function JumpToBottomButton({ onClick }: Props) {
    return (
        <button
            type="button"
            data-testid="jump-to-bottom"
            onClick={onClick}
            aria-label="Jump to latest message"
            className="absolute bottom-20 right-4 z-10 rounded-full border bg-background p-2 shadow-md text-foreground hover:bg-accent"
        >
            <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 stroke-current"
                fill="none"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
            >
                <path d="M6 9l6 6 6-6" />
            </svg>
        </button>
    );
}
```

### 5. `web/src/components/JumpToBottomButton.stories.tsx` — story

Single `Default` story rendered against a placeholder parent so the
absolute positioning has context. `onClick: fn()`.

### 6. `web/src/routes/chat.tsx` — wire the hook

```tsx
import { useChatScroll } from '@/hooks/useChatScroll';
// ...
const scroll = useChatScroll(messages, handle ?? '');
// ...
<ChatView
    // ...existing props...
    scrollContainerRef={scroll.setScrollEl}
    showJumpToBottom={scroll.showJumpToBottom}
    onJumpToBottom={scroll.jumpToBottom}
/>
```

### 7. `web/src/components/ChatView.stories.tsx` — pass new props

All existing stories add `scrollContainerRef: () => {}`,
`showJumpToBottom: false`, `onJumpToBottom: fn()`. Add one new story
`WithScrolledUpIndicator` with `showJumpToBottom: true` to cover the
indicator visual.

### 8. Playwright e2e — extend an existing spec

Cheapest integration test: in [web/e2e/first-conversation.spec.ts](../web/e2e/first-conversation.spec.ts)
(or whichever spec already lands ≥10 messages between two users), after
the last message arrives, assert:

```ts
await expect(page.getByTestId('jump-to-bottom')).toBeHidden();
// The newest message is in view:
await expect(page.getByText(LAST_MESSAGE_TEXT)).toBeInViewport();
```

If no existing spec hits enough messages to require scrolling, prefer
extending [docs/scenarios/first-conversation.md](../docs/scenarios/first-conversation.md)
+ spec rather than adding a one-off — keep the scenario/spec parity.

## Out of scope

- **Scroll to a specific message** (e.g. from a notification or deep link).
  No deep-linking exists yet; revisit when it does.
- **"Unread above" line marker.** A simple boolean indicator is enough for
  v0.1; positioning a divider where the user left off is a separate UX
  effort.
- **Smooth scrolling animation.** Hard-jump is fine for now; users expect
  instant on chat open.
- **Virtualization compatibility.** When [message-virtualization](message-virtualization.md)
  lands later, this hook will be rewritten to use the virtualizer's
  `scrollToIndex` API instead of raw `scrollTop`. The public contract
  (callback ref + state + handlers) stays the same.

## Verify

- `make lint test` — passes; new `useChatScroll.test.ts` cases all pass;
  architecture lint passes (no new `useEffect`/`useRef` in `components/`).
- Storybook (`make web-storybook` on `:6006`) — `JumpToBottomButton/Default`
  and `Chat/ChatView/WithScrolledUpIndicator` render correctly in both
  light and dark mode.
- `make dev` → manual:
  1. Open a chat with many messages → opens at the newest message (no
     manual scroll required).
  2. Scroll up to read history → indicator appears at bottom-right after
     the next incoming message arrives.
  3. Click the indicator → jumps to bottom; indicator disappears.
  4. While scrolled up, type and send a message → scrolls to bottom
     automatically (user's own send wins).
  5. Switch to a different chat → opens at its newest message; no
     residual indicator from the previous chat.
  6. On mobile (or DevTools device emulation), open the virtual keyboard
     while at the bottom → still at the bottom after the layout shift.
- Playwright e2e in step 8 above passes.
