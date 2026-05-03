# Draft persistence — survive refresh without losing typed message

## Current state

`inputValue` in `web/src/components/ChatView.tsx:34` is plain React state. A
page refresh (including a PWA auto-update) silently discards whatever the user
had typed but not yet sent.

## Approach

Persist the draft to `localStorage` under a per-conversation key. Restore it
on mount. Clear it on successful send.

No debounce needed — the `onChange` handler already fires on every keystroke,
and a localStorage write is synchronous and cheap.

## Change

### 1. `web/src/components/ChatView.tsx`

The component receives `handle` as a prop (`Props.handle`, line 9). Use it to
derive the storage key.

```ts
const DRAFT_KEY = (handle: string) => `atmin:draft:${handle}`;
```

**Initialise from storage instead of empty string:**

```ts
// before
const [inputValue, setInputValue] = useState('');

// after
const [inputValue, setInputValue] = useState(
    () => localStorage.getItem(DRAFT_KEY(handle)) ?? '',
);
```

The lazy initialiser runs once on mount — no extra effect needed.

**Persist on every keystroke:**

```ts
// before
onChange={(e) => setInputValue(e.target.value)}

// after
onChange={(e) => {
    const v = e.target.value;
    setInputValue(v);
    if (v) {
        localStorage.setItem(DRAFT_KEY(handle), v);
    } else {
        localStorage.removeItem(DRAFT_KEY(handle));
    }
}}
```

Store the raw value, not trimmed — the user's cursor position and whitespace
are intentional.

**Clear on successful send** — `handleSubmit` already calls `setInputValue('')`
after `onSend(text)`. Add the removal there:

```ts
const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = inputValue.trim();
    if (!text || sending) return;
    onSend(text);
    setInputValue('');
    localStorage.removeItem(DRAFT_KEY(handle));
};
```

### 2. Handle switching conversations

When the user navigates from one conversation to another, `handle` changes but
the component may be reused without unmounting (React Router keeps the route
mounted). The lazy `useState` initialiser only runs once, so a `handle` change
would display the previous conversation's draft.

Add an effect to reset the input when `handle` changes:

```ts
useEffect(() => {
    setInputValue(localStorage.getItem(DRAFT_KEY(handle)) ?? '');
}, [handle]);
```

## Verify

- Type a message in a conversation, refresh the page — text is restored.
- Type in conversation A, navigate to conversation B — input resets (B's
  draft, or empty).
- Navigate back to A — A's draft is still there.
- Send a message — input clears; localStorage key for that handle is gone
  (`Application → Storage → Local storage` in DevTools).
- `cd web && npx vitest run --project=unit` — existing unit tests pass.

## No e2e test

The draft behaviour is trivially covered by the manual checks above.
Playwright cannot easily assert localStorage state across navigation without
extra setup that would be disproportionate for this change.
