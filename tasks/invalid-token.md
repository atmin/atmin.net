# Handle 401 invalid token

## Spec
`docs/scenarios/invalid-token.md`

## Current state

`web/src/lib/api.ts` already handles `403 device_revoked` via a global
`onDeviceRevoked` callback that `useSession` wires to `handleLogout`. There
is no equivalent for 401 — it throws an `APIError` that silently swallows in
catch blocks across the app.

`web/src/hooks/useSession.ts` `handleLogout` calls `deleteDevice(token)` and
then `clearSession()` which calls `deleteDatabase()`. This is too destructive
for a 401 — IndexedDB must survive so message history is available immediately
after re-authentication.

`web/src/lib/auth.ts` `clearSession()` always deletes the database. There is
no lighter variant that clears only localStorage.

## Change

### 1. `web/src/lib/auth.ts`

Add `clearToken()` — clears only the localStorage keys, leaves IndexedDB
untouched:

```ts
export function clearToken(): void {
    localStorage.removeItem(`${LS_PREFIX}token`);
    localStorage.removeItem(`${LS_PREFIX}userId`);
    localStorage.removeItem(`${LS_PREFIX}deviceId`);
    localStorage.removeItem(`${LS_PREFIX}handle`);
    localStorage.removeItem(`${LS_PREFIX}sharingPublicKeyBytes`);
}
```

### 2. `web/src/lib/api.ts`

Mirror the `onDeviceRevoked` pattern for `onUnauthorized`:

```ts
let onUnauthorized: (() => void) | null = null;

export function setOnUnauthorized(cb: (() => void) | null): void {
    onUnauthorized = cb;
}
```

In `request()`, add alongside the existing 403 check:

```ts
if (res.status === 401) onUnauthorized?.();
```

In `storeGet()`, add the same check after the existing `device_revoked`
branch.

### 3. `web/src/hooks/useSession.ts`

Add `handleUnauthorized` — lighter than `handleLogout`: no `deleteDevice`
call, uses `clearToken()` instead of `clearSession()`:

```ts
const handleUnauthorized = useCallback(async () => {
    setSessionManager((prev) => { prev?.destroy(); return null; });
    setSession(null);
    await new Promise((r) => setTimeout(r, 0));
    clearToken();
}, []);
```

Wire it up alongside `setOnDeviceRevoked`:

```ts
useEffect(() => {
    setOnUnauthorized(handleUnauthorized);
    return () => setOnUnauthorized(null);
}, [handleUnauthorized]);
```

Import `clearToken` from `@/lib/auth` and `setOnUnauthorized` from `@/lib/api`.

## Verify

- `cd web && npx tsc --noEmit` passes
- `cd web && npm test` passes
- E2e test passes (see below)

### E2e test — `web/e2e/invalid-token.spec.ts`

```
describe('Invalid token (401)')

test: 'returns to welcome screen on 401 and preserves IndexedDB history'

  1. Register Alice with mnemonic (registerUserWithMnemonic)
  2. Register Bob (registerUser)
  3. Bob opens chat with Alice, sends 'Hello before 401'
  4. Alice opens chat with Bob, waits for 'Hello before 401'
  5. Corrupt Alice's token:
       alice.evaluate(() => localStorage.setItem('atmin:token', 'invalid'))
  6. Reload Alice's page (alice.reload())
  7. Assert Alice is on the welcome screen:
       alice.waitForSelector('text=Your handle') should NOT be visible;
       assert URL is '/' or welcome page selector is visible
  8. Assert IndexedDB still has messages:
       alice.evaluate(() => /* open 'atmin' IDB, count messages store */)
       expect count > 0
  9. Alice logs in again (loginUser(alice, aliceHandle, aliceMnemonic))
  10. Alice opens chat with Bob
  11. Assert 'Hello before 401' is visible immediately (from IndexedDB,
      before server sync completes — no artificial delay needed since
      IndexedDB load is synchronous before fetch)
```

No new helpers needed beyond the existing `registerUserWithMnemonic` and
`loginUser`.
