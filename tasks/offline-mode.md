# Offline mode

## Spec
`docs/scenarios/offline-mode.md`

## Current state

`web/src/hooks/useChat.ts` no longer owns sync or SSE. It reads messages
from IndexedDB and subscribes to `onInboxUpdated` notifications. No
connectivity awareness, no change needed for reads.

`web/src/hooks/useInboxSync.ts` owns the SSE connection. The effect:
- Calls `syncAndPublish` once on mount.
- Opens an `EventSource` and re-syncs on each `new_message` event.
- On `onerror`: closes the connection, then performs a one-shot
  `storeList` fallback gated by `navigator.onLine` (lines 27-32).
- Never reconnects when connectivity returns. `navigator.onLine` is read
  once per error, not subscribed to.

`web/src/hooks/useChatSend.ts` (`sendText`, `sendMedia`) attempts the
send regardless of connectivity. Failures surface as `alert('Failed to
send …')`.

`web/src/components/ChatView.tsx` disables the Send button only on
`!inputValue.trim() || sending || !encryptionReady`. The attach button
uses the same gate. The text input placeholder is hardcoded
`"Type a message..."`.

No `useOnlineStatus` hook exists. No offline indicator exists in the UI.

## Change

### 1. `web/src/hooks/useOnlineStatus.ts` (new)

```ts
import { useEffect, useState } from 'react';

export function useOnlineStatus(): boolean {
    const [online, setOnline] = useState(navigator.onLine);
    useEffect(() => {
        const up = () => setOnline(true);
        const down = () => setOnline(false);
        window.addEventListener('online', up);
        window.addEventListener('offline', down);
        return () => {
            window.removeEventListener('online', up);
            window.removeEventListener('offline', down);
        };
    }, []);
    return online;
}
```

Colocated Vitest unit test covers: initial value from `navigator.onLine`,
transitions on `window` `online` / `offline` events, listener cleanup.

### 2. `web/src/hooks/useInboxSync.ts`

- Call `useOnlineStatus()` and add `online` to the effect's dependency
  array.
- Early-return from the effect when `!online`: do not call
  `syncAndPublish`, do not open `EventSource`. When `online` flips true,
  the effect re-runs from the top — `syncAndPublish` catches any missed
  messages and a fresh `EventSource` is opened.
- Remove the one-shot `storeList` fallback in `onerror` (lines 29-31).
  It is now redundant: the next `syncAndPublish` will run automatically
  when the effect re-runs on reconnect. Keep `events.close()` in
  `onerror`.

### 3. `web/src/hooks/useChatSend.ts`

- Call `useOnlineStatus()`.
- Return `online` alongside `sending`, `sendText`, `sendMedia`.
- Guard both `sendText` and `sendMedia` with `if (!online) return;` at
  the top, after the existing `sending` / `sessionManager` guards. No
  toast or alert — the UI disables the Send button while offline, so a
  triggered send is a belt-and-suspenders path (e.g. Enter key races a
  connectivity flip). Silent return is correct here.

### 4. `web/src/hooks/useChat.ts`

- Add `online: boolean` to `ChatState` and return it (forwarded from
  `useChatSend`).

### 5. `web/src/routes/chat.tsx`

- Destructure `online` from `useChat(...)` and pass it as a prop to
  `<ChatView />`.

### 6. `web/src/components/ChatView.tsx`

- Add `online: boolean` to `Props`.
- Add `|| !online` to the Send button's `disabled` condition (line 135).
- Add `|| !online` to the attach button's disabled gating (line 106-117).
- When `!online`, change the text input's `placeholder` to
  `"You are offline"`. (The input itself stays editable so users can
  draft while offline; only the send is blocked.)
- Update the `ChatView.stories.tsx` to include an `online: false` story.

### 7. `web/src/components/OfflineIndicator.tsx` (new)

A presentational component with no props beyond standard React. Mirrors
`SWUpdateToast`'s positioning and styling so the visual language is
consistent:

```tsx
export function OfflineIndicator() {
    return (
        <div
            data-testid="offline-indicator"
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg text-sm"
        >
            <span>You are offline</span>
        </div>
    );
}
```

Add `OfflineIndicator.stories.tsx` with a single default story.

### 8. `web/src/routes/app.tsx`

- Call `useOnlineStatus()`.
- Render `<OfflineIndicator />` conditionally next to `<SWUpdateToast>`
  (after `<Routes>`, before the closing `</BrowserRouter>`):

```tsx
{!online && <OfflineIndicator />}
```

If both the SW toast and the offline indicator are visible at the same
time they will stack — acceptable for v0.1; visual collision is
extremely rare (SW updates are not triggered while offline).

## Verify

Gate, in the order required by `CONTRIBUTING.md`:

```
make fmt
make lint
make test
make e2e-local SPEC=offline
```

Manual check: `make web-storybook`, view OfflineIndicator and the new
`ChatView online=false` story in both light and dark mode.

### E2e test — `web/e2e/offline-mode.spec.ts`

Playwright supports `browserContext.setOffline(true/false)` to toggle
network access at the context level.

```
describe('Offline mode')

test: 'shows cached messages offline, blocks send, syncs on reconnect'

  1.  Register Alice with mnemonic (registerUserWithMnemonic) — needed
      so Alice can log back in; also register Bob (registerUser).
  2.  Bob opens chat with Alice, sends 'Message before offline'.
  3.  Alice opens chat with Bob, waits for 'Message before offline'
      (ensures it is saved to IndexedDB).
  4.  Go offline: aliceContext.setOffline(true).
  5.  Alice reloads the page (alice.reload()).
  6.  Alice navigates back to the chat with Bob (openChat).
  7.  Assert 'Message before offline' is visible (from IndexedDB).
  8.  Assert offline indicator is visible:
        expect(alice.locator('[data-testid="offline-indicator"]'))
            .toBeVisible()
  9.  Alice tries to send 'Offline message':
        - fill the input
        - assert the Send button is disabled:
            expect(alice.getByRole('button', { name: 'Send' }))
                .toBeDisabled()
        - assert the input placeholder reads 'You are offline':
            expect(alice.getByPlaceholder('You are offline'))
                .toBeVisible()
        - assert 'Offline message' is NOT in the message list
  10. Bob sends 'Message while Alice offline' (Bob is still online).
  11. Come back online: aliceContext.setOffline(false).
  12. Wait for Alice's offline indicator to disappear:
        expect(alice.locator('[data-testid="offline-indicator"]'))
            .toBeHidden()
  13. Wait for 'Message while Alice offline' in Alice's chat
      (waitForMessage).
  14. Assert 'Offline message' is still not in the list (was never sent).
  15. Alice now sends 'After reconnect' successfully and Bob receives it
      (waitForMessage on Bob's side). Confirms sends work after the
      online flip without a manual page refresh.
```

No new helpers needed — `registerUser`, `registerUserWithMnemonic`,
`openChat`, `waitForMessage` already exist in `web/e2e/helpers.ts`.
