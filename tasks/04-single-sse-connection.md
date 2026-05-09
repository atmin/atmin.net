# Consolidate SSE into a single app-level connection

## Spec
`docs/specs/mvp-v0.1.md` "Realtime events": the client opens a single SSE stream `GET /v1/events` and reacts to `new_message` events by running the normal sync algorithm.

`docs/decisions/adr-0004-sse-realtime-notifications.md` describes one SSE connection per device; multi-tab is acknowledged.

`docs/specs/mvp-v0.1.md` "Acceptance tests" — Activity tracking:
> SSE connect sets `last_active` in profile. Second SSE connect within 1 hour does not update `last_active`.

## Current
The web client opens **two** SSE connections per tab whenever a chat is open:

- `web/src/hooks/useChat.ts` — opens `new EventSource('/v1/events?token=…')` and listens for `new_message`, then calls `syncMessages`.
- `web/src/hooks/useConversations.ts` — opens its own `new EventSource('/v1/events?token=…')` for the chats list, also listens for `new_message`, also calls `fetchMessages`.

Effects: doubled connection count, doubled `last_active` writes (the second is suppressed by the 1h gate in `server/events.go`, but it's still a wasted GET object + JSON parse), split-brain reconnect logic, and confusing telemetry.

## Change
1. Create `web/src/hooks/useEvents.ts` — a fan-out hook that owns exactly one `EventSource` for the current session and exposes a subscribe API:
   ```ts
   export function useEvents(token: string | undefined): {
       subscribe: (event: 'new_message', cb: () => void) => () => void;
       online: boolean; // bonus, can defer if it complicates this task
   }
   ```
   Internally: a single `EventSource`, a `Set<() => void>` of subscribers, `addEventListener('new_message', () => listeners.forEach(fn => fn()))`. Reconnect on `onerror` follows the existing logic from `useChat` (probe with `storeList` to surface 401 via `setOnUnauthorized`).
2. Hoist `useEvents(session?.token)` into `web/src/routes/app.tsx` so the connection's lifecycle matches the session, not a chat route. Pass the returned `subscribe` down to `useChat` and `useConversations` via React context (a small `EventsContext`) — this is the cleanest way without violating the architecture rule that `components/` cannot import value from `hooks/`. The context provider lives in `routes/app.tsx`; consumers are other hooks.
3. Remove the `EventSource` instantiation from `useChat` and `useConversations`; replace with `subscribe('new_message', () => syncMessages(...))` in their respective `useEffect`s.
4. Confirm `architecture lint` still passes (`make web-lint-arch`). Hooks may import from other hooks via the central context; if not, make `useEvents` a `lib/` module that returns an `EventTarget`-like object instead of using context.

## Verify
- `make lint test` passes.
- New unit test for `useEvents` (with a mocked `EventSource`): subscribing twice and dispatching `new_message` invokes both callbacks; unsubscribe stops the callback; closing the source on unmount calls `EventSource.close`.
- Manual: open DevTools → Network → EventStream filter on `/v1/events`. Before this task there are 2 streams while a chat is open; after, exactly 1.
- E2E: existing `web/e2e/first-conversation.spec.ts` still passes — assert it indirectly (it sends a message and expects the recipient to render it via SSE).
- `last_active` should now be written at most once per device session (verifiable in MinIO console / by inspecting `users/{uid}/profile.json`).
