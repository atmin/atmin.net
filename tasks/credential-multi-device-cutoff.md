# Credential overhaul 5/5 — other-device cutoff on `key_version_stale`

Part of the credential-overhaul task group:

1. [credential-registration](credential-registration.md) — registration UI + Argon2id + salt
2. [credential-rotate-endpoint](credential-rotate-endpoint.md) — server `POST /v1/rotate-keys`
3. [credential-backup-chain](credential-backup-chain.md) — `key_chain.json` + envelope versioning
4. [credential-rotate-ui](credential-rotate-ui.md) — settings UI for "change password"
5. **credential-multi-device-cutoff** (this file) — handle `401 key_version_stale`

## Motivation

When a user rotates their password on device A, every other device
holds a stale token bound to the previous `key_version`. The
server's auth middleware (task 2) returns `401 key_version_stale`
on those devices' next request. This task makes the client react
gracefully: wipe local state, redirect to login, present a one-line
"this account was rotated on another device" notice.

Without this, users hitting a rotated account from a stale device
just see a generic auth error — exactly the kind of WTF moment we
want to avoid.

Depends on task 2. Can ship in parallel with tasks 3 and 4 — those
produce the `401 key_version_stale` path, this consumes it.

Specs: [ADR-0012](../docs/decisions/adr-0012-backup-secret-rotation.md)
(*Multi-device propagation*),
[mvp-v0.1.md#auth](../docs/specs/mvp-v0.1.md#auth),
[mvp-v0.1.md#error-responses](../docs/specs/mvp-v0.1.md#error-responses).

## Current state

- [api.ts:5-26](../web/src/lib/api.ts) defines `APIError` and an
  `EventTarget`-based auth-event bus with two event types:
  `device_revoked`, `unauthorized`.
- [api.ts:43-52](../web/src/lib/api.ts) emits `device_revoked` on
  `403 device_revoked`, `unauthorized` on any `401`.
- Subscribers to `device_revoked` already clear local state and
  redirect to login (`/components/App.tsx` or similar — verify the
  exact wire-up; this task plugs in alongside it).
- `unauthorized` is currently handled (or ignored) less
  specifically; for a stale token the user sees a generic auth
  error.

## Architecture constraints

- Detection happens at the API layer. UI components do not parse
  status codes.
- The wipe + redirect path reuses existing infrastructure
  (`clearSession` from [auth.ts](../web/src/lib/auth.ts) +
  navigation to `/login`). Do not duplicate.
- The notice text travels through routing state, not global
  toast/alert state (which doesn't survive the navigation).

## Change

### 1. Add a third auth-event type

[api.ts:15](../web/src/lib/api.ts):

```ts
type AuthEvent = 'device_revoked' | 'unauthorized' | 'key_version_stale';
```

Update `onAuthEvent` / `emitAuth` type unions accordingly.

### 2. Emit on `401 key_version_stale`

[api.ts:43-52](../web/src/lib/api.ts) — extend the error branch:

```ts
if (!res.ok) {
    const err = await res.json().catch(() => ({ error: 'unknown', message: res.statusText }));
    if (res.status === 403 && err.error === 'device_revoked')
        emitAuth('device_revoked');
    if (res.status === 401 && err.error === 'key_version_stale')
        emitAuth('key_version_stale');
    else if (res.status === 401)
        emitAuth('unauthorized');
    throw new APIError(res.status, err.error, err.message);
}
```

Mirror the same branch in the second error site (line ~210, the
`storeGet` path). Consider extracting the error-classification logic
into a small helper to keep both sites identical.

The error response body carries `{ "error": "key_version_stale",
"current": N }`. The `current` field is informational — the client
doesn't need it for the wipe path (just for diagnostics or future
"the account is now at version N" messaging). Persist it on the
`APIError` instance as an optional extra field:

```ts
export class APIError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
        public extra?: Record<string, unknown>,
    ) { super(message); }
}
```

### 3. Subscribe to the event at the app root

Locate the existing `device_revoked` subscriber (in
`web/src/components/App.tsx` or wherever it lives; grep for
`onAuthEvent('device_revoked'`). Add a parallel subscription for
`key_version_stale`:

```ts
useEffect(() => {
    return onAuthEvent('key_version_stale', async () => {
        await clearSession();
        navigate('/login', { state: { notice: 'rotated_elsewhere' } });
    });
}, []);
```

`clearSession` already wipes localStorage + IDB
([auth.ts:71-74](../web/src/lib/auth.ts)). No additional cleanup
is needed.

### 4. Login route consumes the notice

[login.tsx](../web/src/routes/login.tsx) reads `location.state`:

```ts
const location = useLocation();
const notice = (location.state as { notice?: string } | null)?.notice;
```

When `notice === 'rotated_elsewhere'`, the login form renders a
one-line, calm explanation above the handle field: *"This account
was rotated on another device. Please sign in with your new
password."* The notice is dismissed by any further user
interaction.

This message lives in [LoginForm.tsx](../web/src/components/LoginForm.tsx)
as a new optional prop `notice?: 'rotated_elsewhere' | 'session_expired' | null`,
rendering a small `text-muted-foreground` line. Future task-D-style
notices reuse the same prop.

### 5. SSE connection tears down on `key_version_stale`

The SSE handler ([web/src/hooks/useInboxSync.ts](../web/src/hooks/useInboxSync.ts))
opens `GET /v1/events?token=...`. On rotation, that connection
returns a stream error or closes server-side. Without intervention,
the hook's reconnection logic would retry against the dead token,
producing noise (and confusing 401s in the network panel).

The hook subscribes to the auth-event bus and tears down on
`key_version_stale`:

```ts
useEffect(() => {
    return onAuthEvent('key_version_stale', () => {
        eventSourceRef.current?.close();
        eventSourceRef.current = null;
    });
}, []);
```

The `device_revoked` path already does the equivalent — extend the
existing subscription (or add a sibling one — match whichever
pattern the file already uses) rather than introducing a new
disconnection mechanism.

### 6. Storage API errors

The store endpoints (`store/list`, `store/object`, `store/presign`)
share the same `request` helper, so they inherit the new behaviour
automatically. Confirm no separate fetch sites bypass `request`.

## Out of scope

- Detecting that the *server* doesn't know about the user (full
  account deletion). That's already covered by `403 device_revoked`.
- Cross-tab broadcasting of the wipe. If a user has the PWA open in
  two tabs and rotates in tab A, tab B will catch up on its next
  request. Adding `BroadcastChannel` notification is a follow-up.
- Recovering data after a wipe. None expected — local state was
  encrypted with keys that no longer match the server's, so its
  utility on a stale token is zero.

## Verify

`make fmt lint test` clean.

**Vitest:**

- `api.test.ts` (extend existing):
  - `401 key_version_stale` response emits `key_version_stale`,
    does **not** emit `unauthorized`.
  - Plain `401 unauthorized` still emits `unauthorized`.
  - `403 device_revoked` still emits `device_revoked` (regression
    guard).
  - `APIError.extra` carries `{current: N}` for stale responses.

- `App.test.ts` (or equivalent root-subscriber test):
  - Firing `key_version_stale` calls `clearSession` and navigates
    to `/login` with `state.notice === 'rotated_elsewhere'`.

- `LoginForm.test.ts`:
  - `notice='rotated_elsewhere'` renders the explanatory line.
  - User typing in the form does not re-render the notice (or it
    fades on first interaction — pick one and test it).

- `useInboxSync.test.ts` (extend) — SSE teardown:
  - Mount the hook with a mocked `EventSource` (or pass a fake
    constructor via DI as the existing tests already do).
  - Fire `emitAuth('key_version_stale')` via the public
    `onAuthEvent` bus.
  - Assert `EventSource.close()` was called and that no
    reconnection attempt fires on the next tick.
  - Regression guard: firing `unauthorized` (the generic 401 case)
    does **not** tear down the SSE — that path has its own
    reconnect semantics and shouldn't be affected by this change.

**Playwright e2e (`web/e2e/credential-multi-device-cutoff.spec.ts`):**

1. Alice registers on context A with password `pw-1`.
2. Alice "logs in on another device" using context B with the same
   password (existing helper `loginUser`). Both contexts hold valid
   tokens for `key_version: 1`.
3. Both contexts open the chat with the saved-messages route and
   exchange a self-message to confirm both are working.
4. Context A navigates to settings, rotates password to `pw-2`.
5. Context B sends any request (e.g. navigates to the conversations
   list). Within a second or two, context B is redirected to
   `/login` with the `rotated_elsewhere` notice visible.
6. Context B signs in with `pw-2` — works. With `pw-1` — fails.
7. Both contexts can again exchange a self-message (history from
   step 3 still decrypts via the chain).

**Manual:**

- Phone + laptop on the same staging account. Rotate on laptop.
  Bring the phone out of the background. Confirm it kicks to the
  login screen with the notice, sign in with the new password,
  history is still readable. Same test in reverse (rotate on
  phone, observe laptop).
