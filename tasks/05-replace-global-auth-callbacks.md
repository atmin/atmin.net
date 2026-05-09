# Replace module-level auth callbacks with an event bus

## Spec
No spec section — this is internal hygiene. The user-facing contract (auto-logout on 401, self-wipe on 403 `device_revoked` per `docs/scenarios/stolen-device.md` and `docs/scenarios/invalid-token.md`) must be preserved exactly.

## Current
`web/src/lib/api.ts` exports two module-level setters:
```ts
let onDeviceRevoked: (() => void) | null = null;
export function setOnDeviceRevoked(cb): void { onDeviceRevoked = cb; }
let onUnauthorized: (() => void) | null = null;
export function setOnUnauthorized(cb): void { onUnauthorized = cb; }
```
Consumers: `web/src/hooks/useSession.ts` registers callbacks in two `useEffect`s; the cleanups call `setOnDeviceRevoked(null)` / `setOnUnauthorized(null)`. There is also a fragile `await new Promise(r => setTimeout(r, 0))` in `handleLogout` / `handleUnauthorized` to flush React unmounts before tearing down IndexedDB.

Problems:
- Module-level mutable singletons + React StrictMode's double-mount lead to register/cleanup races. The setTimeout(0) is the symptom.
- Only one consumer can register at a time — adding a second listener (e.g. analytics on logout) silently overwrites.
- Tests must reset the module state manually.

## Change
1. In `web/src/lib/api.ts`, replace the two pairs of `let onX / setOnX` with a typed `EventTarget`:
   ```ts
   type AuthEvent = 'device_revoked' | 'unauthorized';
   const authEvents = new EventTarget();
   export function onAuthEvent(type: AuthEvent, cb: () => void): () => void {
       const handler = () => cb();
       authEvents.addEventListener(type, handler);
       return () => authEvents.removeEventListener(type, handler);
   }
   // Internal:
   function emitAuth(type: AuthEvent) { authEvents.dispatchEvent(new Event(type)); }
   ```
   Replace the `onDeviceRevoked?.()` / `onUnauthorized?.()` calls with `emitAuth('device_revoked')` / `emitAuth('unauthorized')`. Both call sites in `request()` and the inline ones in `storeGet` / `fetchMedia` are equivalent.
2. In `web/src/hooks/useSession.ts`:
   - Replace the two `useEffect`s that call `setOnX` with one `useEffect` that subscribes to both events and returns the combined unsubscribe.
   - Investigate whether the `await new Promise(r => setTimeout(r, 0))` is still needed once registration is no longer a singleton overwrite. Likely yes (it flushes the `setSession(null)` unmount so IDB connections close before `clearSession` calls `deleteDatabase`). Keep it but add a comment pointing at `db.ts`'s `onblocked` handler so the workaround is discoverable.
3. Confirm `setOnDeviceRevoked` / `setOnUnauthorized` are removed from the module. Update any test that imported them.

## Verify
- `make lint test` passes.
- New unit test in `web/src/lib/api.test.ts`: two `onAuthEvent('device_revoked', cb1)` / `onAuthEvent('device_revoked', cb2)` subscriptions both fire on a 403 response; one `unsubscribe()` stops only its callback.
- Existing `web/src/lib/auth.test.ts` and any session-related tests still pass.
- Manual: log in, then `kubectl/scw delete` the device file (or use `mc rm` against MinIO) and trigger any API call → app self-wipes back to the welcome screen (preserved behaviour).
