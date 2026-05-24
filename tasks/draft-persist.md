# Draft persistence — survive refresh without losing typed message

## Motivation

A page refresh (including a PWA service-worker auto-update) silently discards
whatever the user had typed but not yet sent.

The SW update path is already written to suppress auto-reload while a draft
exists ([useSWUpdate.ts:10-15](../web/src/hooks/useSWUpdate.ts) checks
`localStorage` for keys with prefix `atmin:draft:`), but no code currently
writes those keys — so the gate is permanently open. Landing draft persistence
both fixes the typed-message-lost UX and activates the existing SW gate.

## Current state

- `inputValue` lives in `useState` inside
  [ChatView.tsx:37](../web/src/components/ChatView.tsx). Lost on every remount.
- [useSWUpdate.ts:10-12](../web/src/hooks/useSWUpdate.ts) inspects
  `localStorage` for any `atmin:draft:*` key — the prefix is settled, no key
  writes exist.
- `handle` is passed to `ChatView` as a prop
  ([ChatView.tsx:11](../web/src/components/ChatView.tsx)) and originates from
  `useParams<{ handle: string }>()` in
  [chat.tsx:21](../web/src/routes/chat.tsx).

## Architecture constraints

`components/` cannot use `useEffect`/`useCallback`/`useMemo`/`useRef`, and
cannot value-import from `@/hooks/`. Both are enforced by
[lint-architecture.sh](../web/scripts/lint-architecture.sh).

Therefore the persistence lives in a hook called from the **route**, and the
value is passed to `ChatView` as props. `ChatView` stays presentational.

## Change

### 1. `web/src/hooks/useDraft.ts` — new hook

```ts
import { useEffect, useState } from 'react';

const DRAFT_KEY = (handle: string) => `atmin:draft:${handle}`;

export function useDraft(handle: string): [string, (v: string) => void] {
    const [value, setValueState] = useState(
        () => localStorage.getItem(DRAFT_KEY(handle)) ?? '',
    );

    // Reload when handle changes — route reuses the same ChatView across
    // /:handle navigations, so the lazy initializer alone is not enough.
    useEffect(() => {
        setValueState(localStorage.getItem(DRAFT_KEY(handle)) ?? '');
    }, [handle]);

    const setValue = (v: string) => {
        setValueState(v);
        if (v) localStorage.setItem(DRAFT_KEY(handle), v);
        else localStorage.removeItem(DRAFT_KEY(handle));
    };

    return [value, setValue];
}
```

API mirrors `useState<string>` deliberately — callers swap it in with no other
changes. Setting `''` clears the storage key, so no explicit `clear()` method
is needed: the existing `setInputValue('')` after a successful send doubles as
the clear.

### 2. `web/src/hooks/useDraft.test.ts` — new unit tests

Pattern matches [useOnlineStatus.test.ts](../web/src/hooks/useOnlineStatus.test.ts):
`// @vitest-environment happy-dom`, `renderHook` from
`@testing-library/react`. happy-dom provides `localStorage`.

Required cases (use `beforeEach(() => localStorage.clear())` to isolate):

| Test | Setup | Assert |
|---|---|---|
| empty when no stored draft | nothing | `result.current[0] === ''` |
| initialises from localStorage | `localStorage.setItem('atmin:draft:alice', 'hi')` | `result.current[0] === 'hi'` |
| setValue writes to localStorage | call `setValue('hello')` | `localStorage.getItem('atmin:draft:alice') === 'hello'` |
| setValue('') removes the key | seed, then call `setValue('')` | `localStorage.getItem(...) === null` |
| handle change reloads from new key | seed both `atmin:draft:alice` and `atmin:draft:bob`; rerender with new handle | value updates to bob's draft |
| handle change with no stored draft | seed only `atmin:draft:alice`; rerender to `bob` | value resets to `''` |

### 3. `web/src/routes/chat.tsx` — call the hook, pass props down

```ts
import { useDraft } from '@/hooks/useDraft';
// ...
const [inputValue, setInputValue] = useDraft(handle ?? '');
```

Pass `inputValue` and `setInputValue` to `<ChatView ... />` as new props.

### 4. `web/src/components/ChatView.tsx` — controlled input

```ts
interface Props {
    // ...existing...
    inputValue: string;
    setInputValue: (v: string) => void;
}
```

Remove the internal `const [inputValue, setInputValue] = useState('');` —
destructure from props instead. The existing `handleSubmit` already calls
`setInputValue('')` after `onSend(text)`; with the new prop, that one line
both clears the input AND removes the localStorage key (hook's setter treats
empty string as delete).

`handleSubmit` still short-circuits on `!online` (line 42 today), so a draft
typed offline is preserved until the user is online again and submits.

No other ChatView changes — markup and flow untouched.

### 5. `web/src/components/ChatView.stories.tsx` — update story args

Each story now must pass `inputValue` and `setInputValue`. For static stories
(`Empty`, `Loading`, `WithMessages`, `Sending`, `SavedEmpty`, `Offline`),
pass `inputValue=""` and `setInputValue: fn()` (already imported from
`storybook/test`).

Optionally add a `Draft` story that pre-fills `inputValue="half-typed
message…"` to visually verify the controlled input renders correctly.

## Why not just `key={handle}` to force remount?

A simpler alternative would be `<ChatView key={handle} ... />` plus inline
`localStorage` reads/writes inside `ChatView`. Rejected because:

- `ChatView` would still need a lazy `useState` initializer and an `onChange`
  that writes localStorage — that's side-effect logic in a component, even
  without `useEffect`.
- No hook unit tests would exist for the persistence behaviour.
- Hooks/components split is the established pattern (`useOnlineStatus`,
  `useChat`, `useChatSend`, etc).

## Verify

- `make lint test` — passes; the new `useDraft.test.ts` cases all pass; the
  architecture lint passes (no new `useEffect` in `components/`, no value
  import from `@/hooks/` in `components/`).
- Manual:
  1. Type a message, refresh the page → text restored.
  2. Type in `/alice`, navigate to `/bob` → input shows bob's draft (or empty).
  3. Navigate back to `/alice` → alice's draft restored.
  4. Send a message → input clears; DevTools `Application → Local Storage`
     shows no `atmin:draft:alice` key.
  5. Type a draft, then in DevTools `Application → Service Workers` →
     `Update`. With the draft present, [useSWUpdate.ts](../web/src/hooks/useSWUpdate.ts)
     `hasDraft` is now `true` → auto-reload is suppressed; the
     `SWUpdateToast` still appears for manual reload.
- Offline draft survival: DevTools → Network → Offline, type a message,
  refresh → text restored. (Send is gated by `online`, so the draft is not
  accidentally cleared by a failed submit attempt.)

## No e2e test

Playwright cannot easily assert localStorage state across navigation, and the
hook unit tests cover the persistence contract deterministically. Manual
checks above cover the end-to-end UX.
