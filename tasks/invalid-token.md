# Handle 401 invalid token

## Spec
`docs/scenarios/invalid-token.md`

## Current state

`web/src/lib/api.ts` already handles `403 device_revoked` via a global
`onDeviceRevoked` callback that `useSession` wires to `handleLogout`. There
is no equivalent for 401 — it throws an `APIError` that silently swallows in
catch blocks across the app.

`web/src/hooks/useChat.ts` SSE `onerror` calls `events.close()` and logs to
console. It does not probe to distinguish a 401 from a network failure. On
mobile (no console) a secret rotation is completely invisible — new messages
stop arriving and the app shows as offline.

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

### 3. `web/src/hooks/useChat.ts` — SSE `onerror` probe

Replace the current `onerror` handler:

```ts
events.onerror = () => {
    events.close();
    if (navigator.onLine) {
        // Server is reachable but rejected the connection.
        // Probe with a regular fetch — if it returns 401, onUnauthorized
        // fires automatically via request() in api.ts.
        storeList(session.token, `inbox/${session.userId}/live/`)
            .catch(() => {
                // TypeError → actually offline, handled by useOnlineStatus.
                // APIError 401 → onUnauthorized already fired.
            });
    }
    // If offline, the useOnlineStatus hook and the `online` dependency on
    // this effect will handle reconnect when connectivity returns.
};
```

Import `storeList` from `@/lib/api` (already used elsewhere in the file via
`fetchMessages`; this is a direct call for the probe).

### 4. `web/src/hooks/useSession.ts`

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

### Unit tests — `web/src/lib/api.test.ts`

Add to `describe('api - device revocation')`, mirroring the existing
`onDeviceRevoked` tests exactly:

```
describe('api - unauthorized (401)')

- 'calls onUnauthorized callback on 401'
    mock fetch → { ok: false, status: 401, json: { error: 'unauthorized', ... } }
    setOnUnauthorized(vi.fn())
    call resolve('any-handle') → expect rejects with { status: 401 }
    expect onUnauthorized called once

- 'does not call onUnauthorized on other 4xx errors'
    mock fetch → 403 forbidden (non-device_revoked)
    setOnUnauthorized(vi.fn())
    expect onUnauthorized not called

- 'does not throw when no callback is registered'
    setOnUnauthorized(null)
    mock fetch → 401
    expect resolve() rejects but does not throw outside the promise

- 'calls onUnauthorized from storeGet() path'
    mock fetch → { ok: false, status: 401, ... } for a storeGet call
    (storeGet is called directly; it has its own fetch — not through request())
    setOnUnauthorized(vi.fn())
    expect onUnauthorized called once
```

Teardown: `afterEach(() => setOnUnauthorized(null))` — same as the existing
`setOnDeviceRevoked(null)` teardown.

### Unit tests — `web/src/lib/auth.test.ts`

Add to `describe('session - Session management')`:

```
describe('clearToken')

- 'removes all localStorage keys but leaves IndexedDB intact'
    await saveSession(testSession)   ← writes localStorage + IndexedDB keys
    clearToken()                     ← synchronous, no await needed
    expect localStorage.getItem('atmin:token') → null
    expect localStorage.getItem('atmin:userId') → null
    expect localStorage.getItem('atmin:deviceId') → null
    expect localStorage.getItem('atmin:handle') → null
    expect localStorage.getItem('atmin:sharingPublicKeyBytes') → null
    const loaded = await loadSession()
    expect(loaded).toBeNull()        ← null because token missing from LS...
    — but verify IndexedDB keys still exist:
    const { getKey } = await import('./db')
    expect(await getKey('sharingPrivateKey')).toBeTruthy()
    expect(await getKey('backupKey')).toBeTruthy()

- 'is idempotent'
    clearToken(); clearToken()
    — should not throw

- 'can be called when no session exists'
    — should not throw
```

Contrast with the existing `clearSession` tests which assert IndexedDB is
also cleared — `clearToken` is the only function where the two diverge.

### E2e test — `web/e2e/invalid-token.spec.ts`

Two tests are needed: the fetch path (easy to trigger) and the SSE path (the
mobile-silent failure).

```
describe('Invalid token (401)')

test: 'fetch path — returns to welcome screen and preserves IndexedDB history'

  1.  Register Alice with mnemonic (registerUserWithMnemonic)
  2.  Register Bob (registerUser)
  3.  Bob opens chat with Alice, sends 'Hello before 401'
  4.  Alice opens chat with Bob, waits for 'Hello before 401'
      (message is now in IndexedDB)
  5.  Corrupt Alice's token in localStorage:
        alice.evaluate(() => localStorage.setItem('atmin:token', 'invalid'))
  6.  Reload Alice's page (alice.reload())
      — on load, fetchMessages fires with the bad token → 401 → onUnauthorized
  7.  Assert Alice is on the welcome screen (not the chat or home view)
  8.  Assert IndexedDB still has messages:
        alice.evaluate(() => new Promise((resolve) => {
          const req = indexedDB.open('atmin');
          req.onsuccess = () => {
            const tx = req.result.transaction('messages', 'readonly');
            const countReq = tx.objectStore('messages').count();
            countReq.onsuccess = () => resolve(countReq.result);
          };
        }))
        expect(count).toBeGreaterThan(0)
  9.  Alice logs in again (loginUser(alice, aliceHandle, aliceMnemonic))
  10. Alice opens chat with Bob
  11. Assert 'Hello before 401' is visible immediately (IndexedDB load
      happens before server sync, so no delay needed)


test: 'SSE path — 401 on SSE connection triggers re-auth prompt, not offline indicator'

  1.  Register Alice with mnemonic (registerUserWithMnemonic)
  2.  Register Bob (registerUser)
  3.  Bob opens chat with Alice, sends 'Hello'
  4.  Alice opens chat with Bob, waits for 'Hello'
  5.  Alice is on the chat view with an active SSE connection
  6.  Corrupt Alice's token (same as above) — this invalidates both the
      SSE connection and any subsequent probe fetch
  7.  Trigger SSE reconnect by briefly going offline then online:
        aliceContext.setOffline(true)
        aliceContext.setOffline(false)
      — the `online` event causes the SSE effect to re-run with the bad
        token, firing onerror → probe → 401 → onUnauthorized
  8.  Assert Alice is on the welcome screen (not the offline indicator)
```

No new helpers needed beyond the existing `registerUserWithMnemonic`,
`loginUser`, and `browserContext.setOffline()`.
