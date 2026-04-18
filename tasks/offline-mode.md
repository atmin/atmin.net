# Offline mode

## Spec
`docs/scenarios/offline-mode.md`

## Current state

`web/src/hooks/useChat.ts`:
- `loadAndSync` has a single `catch` block that logs and swallows all errors.
  It does not distinguish network failure from API errors.
- The SSE `useEffect` calls `events.close()` on `onerror` and never
  reconnects.
- `sendMessage` / `sendMedia` attempt the send regardless of connectivity.

There is no online/offline state anywhere in the app. No offline indicator
exists in the UI.

## Change

### 1. `web/src/hooks/useOnlineStatus.ts` (new file)

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

### 2. `web/src/hooks/useChat.ts`

**Import and use online status:**

```ts
import { useOnlineStatus } from './useOnlineStatus';
// inside useChat:
const online = useOnlineStatus();
```

**Add `online` to `ChatState`** and return it.

**`loadAndSync` — distinguish network failure:**

Split the catch block:

```ts
} catch (error) {
    if (error instanceof TypeError) {
        // Network unavailable — cached view is sufficient, no toast needed
    } else {
        console.error('Failed to load messages:', error);
    }
}
```

The `APIError` 401 path is handled globally by `onUnauthorized` in `api.ts`
and does not need special casing here.

**SSE effect — add `online` as a dependency:**

```ts
useEffect(() => {
    if (!convId || !online) return;   // don't open SSE while offline

    const url = `/v1/events?token=${encodeURIComponent(session.token)}`;
    const events = new EventSource(url);

    events.addEventListener('new_message', async () => { /* existing sync */ });

    events.onerror = () => {
        events.close();
        // No manual reconnect needed: when `online` flips true, this
        // effect re-runs because `online` is in the dependency array.
    };

    // Sync immediately on (re)connect to catch messages missed while offline
    syncMessages();   // extract the fetchMessages + setMessages logic into a
                      // named function reused by both the SSE handler and here

    return () => events.close();
}, [convId, online, session.token, session.userId, session.sharingPrivateKey, sessionManager]);
```

**`sendMessage` / `sendMedia` — guard at the top:**

```ts
if (!online) {
    // surface error to user — replace the existing alert() with whatever
    // error display pattern the UI uses
    alert('You are offline');
    return;
}
```

### 3. Offline indicator in the chat UI

Find the component that renders the chat view (likely `web/src/components/`
or wherever `useChat` is consumed). Add a visible banner or status badge when
`online === false`. Exact styling is left to the implementer; it must be
identifiable by a `data-testid="offline-indicator"` attribute for the e2e
test.

## Verify

- `cd web && npx tsc --noEmit` passes
- `cd web && npm test` passes
- E2e test passes (see below)

### E2e test — `web/e2e/offline-mode.spec.ts`

Playwright supports `browserContext.setOffline(true/false)` to toggle network
access at the context level.

```
describe('Offline mode')

test: 'shows cached messages offline and syncs on reconnect'

  1.  Register Alice with mnemonic (registerUserWithMnemonic) — needed so
      Alice can log back in; also register Bob (registerUser)
  2.  Bob opens chat with Alice, sends 'Message before offline'
  3.  Alice opens chat with Bob, waits for 'Message before offline'
      (ensures it is saved to IndexedDB)
  4.  Go offline: aliceContext.setOffline(true)
  5.  Alice reloads the page (alice.reload())
  6.  Alice navigates back to the chat with Bob (openChat)
  7.  Assert 'Message before offline' is visible (from IndexedDB)
  8.  Assert offline indicator is visible:
        expect(alice.locator('[data-testid="offline-indicator"]')).toBeVisible()
  9.  Alice tries to send 'Offline message':
        alice.getByPlaceholder('Type a message...').fill('Offline message')
        alice.getByRole('button', { name: 'Send' }).click()
        — assert 'Offline message' does NOT appear in the message list
        — assert some error feedback is visible (exact selector TBD by UI impl)
  10. Bob sends 'Message while Alice offline' (Bob is still online)
  11. Come back online: aliceContext.setOffline(false)
  12. Wait for Alice's offline indicator to disappear
  13. Wait for 'Message while Alice offline' to appear in Alice's chat
        waitForMessage(alice, 'Message while Alice offline')
  14. Assert 'Offline message' is still not in the list (was never sent)
```

No new helpers needed.
