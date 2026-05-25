# Custom handles at registration

User-chosen handles replace the server-auto-generated BIP39 pair.
Pairs with the credential-overhaul series (the BIP39 mnemonic is
already going away as a primary credential there; this task removes
the BIP39 *handle* in parallel).

## Motivation

Two of the biggest "WTF" moments in onboarding today are the BIP39
mnemonic and the auto-generated handle. The credential-overhaul
group addresses the mnemonic. This task addresses the handle: users
type the handle they actually want, get a real-time availability
check, and own a memorable identifier.

Specs:
[ADR-0013](../docs/decisions/adr-0013-user-chosen-handles.md),
[mvp-v0.1.md#ids--naming](../docs/specs/mvp-v0.1.md#ids--naming),
[mvp-v0.1.md#register-first-device](../docs/specs/mvp-v0.1.md#register-first-device),
[mvp-v0.1.md#resolve-handle](../docs/specs/mvp-v0.1.md#resolve-handle),
[mvp-v0.1.md#delete-account](../docs/specs/mvp-v0.1.md#delete-account).

## Current state

- [server/handle.go](../server/handle.go) generates a random
  two-BIP39-word handle.
- [server/handlers.go:42-54](../server/handlers.go#L42) — the
  register handler runs that generator + a `HeadObject` collision
  check with up to 10 retries.
- [server/handlers.go:215-241](../server/handlers.go#L215) — the
  resolve handler returns `404` for unknown handles, `200` with
  the projection for known ones. No 410-Gone semantics.
- Account deletion in `DELETE /v1/profile`
  ([server/handlers.go](../server/handlers.go)) currently deletes
  `handles/{handle}.json` outright.
- React Router: [web/src/routes/app.tsx:79](../web/src/routes/app.tsx#L79)
  has `path="/:handle"`. Link sites use `/${encodeURIComponent(handle)}`
  ([ChatsView.tsx:147](../web/src/components/ChatsView.tsx#L147),
  [chats.tsx:30](../web/src/routes/chats.tsx#L30)).
- E2E helper [waitForURL](../web/e2e/helpers.ts) uses `**/${handle}`.
- No reserved-handles list, no charset validation, no cooldown,
  no in-server mutex map for handle claims.

## Architecture constraints

- The registration handler is the single writer of `handles/*.json`
  (apart from the rotate-keys handler which writes the same key on
  rotation). Concurrency control lives in the handler via a
  `sync.Map<handle, *sync.Mutex>` — analogous to the rotation
  mutex in [credential-rotate-endpoint](credential-rotate-endpoint.md).
- The `@` prefix is **UI-only**. The API path
  `GET /v1/resolve/{handle}` and the S3 key `handles/{handle}.json`
  store the bare handle. Don't propagate the `@` into Go code or
  S3 paths.
- The reserved-words file ships embedded in the binary (`//go:embed`),
  not as runtime config. Operator override via the
  `RESERVED_HANDLES_PATH` env var.

## Change

### 1. Reserved-handles file

New `server/reserved_handles.txt`, one handle per line:

```
admin
root
atmin
system
support
help
info
api
www
mail
abuse
postmaster
security
anonymous
deleted
me
```

`server/handle.go` (extending the file that today generates random
handles):

```go
//go:embed reserved_handles.txt
var reservedRaw string

var reservedHandles map[string]bool

func init() {
    reservedHandles = map[string]bool{}
    for _, line := range strings.Split(strings.TrimSpace(reservedRaw), "\n") {
        h := strings.ToLower(strings.TrimSpace(line))
        if h != "" {
            reservedHandles[h] = true
        }
    }
}
```

`RESERVED_HANDLES_PATH` env var, read at server start, replaces
the embedded list when set (the embedded list is the fallback /
default).

### 2. Handle validation

`server/handle.go`:

```go
var handleRegex = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}[a-z0-9]$`)

// validateHandle returns nil if valid, errHandleInvalid for charset/length
// violations, or errHandleReserved for blocklist matches.
func validateHandle(h string) error {
    if !handleRegex.MatchString(h) {
        return errHandleInvalid
    }
    if strings.Contains(h, "--") {  // no consecutive hyphens
        return errHandleInvalid
    }
    if reservedHandles[h] {
        return errHandleReserved
    }
    return nil
}
```

The regex pins length 3–32 (`{1,30}` interior + first + last = 32
max, 3 min). Single-letter handles are rejected because the regex
requires at least three chars.

### 3. Per-handle mutex map

`server/handle_mutex.go`:

```go
type handleMutexMap struct {
    mu sync.Mutex
    m  map[string]*handleLock
}

type handleLock struct {
    mu       sync.Mutex
    refCount int
}

// acquire returns a release function; blocks up to timeout.
// Returns errHandleClaimContention on timeout.
func (hm *handleMutexMap) acquire(handle string, timeout time.Duration) (release func(), err error)
```

Mirrors the rotation mutex from
[credential-rotate-endpoint](credential-rotate-endpoint.md). Same
ref-count + sweep pattern.

### 4. New error codes

`server/error.go`:

```go
var (
    errHandleInvalid      = APIError{400, "handle_invalid", "Handle does not match the required format"}
    errHandleReserved     = APIError{400, "handle_reserved", "Handle is reserved"}
    errHandleTaken        = APIError{409, "handle_taken", "Handle is already registered"}
    errHandleInCooldown   = APIError{409, "handle_in_cooldown", "Handle is in 30-day cooldown after deletion"}
    errHandleReleased     = APIError{410, "released", "Handle was deleted; in cooldown"}
)
```

`errHandleInCooldown` and `errHandleReleased` carry `released_at`
and `available_at` (= `released_at + 30d`) in the response body —
use a per-call extras helper analogous to the `current` field on
`key_version_stale`.

### 5. Register handler rewrite

[server/handlers.go](../server/handlers.go) `register`:

- Accept new field `handle` (string) on the input.
- Before any other work: `validateHandle(req.Handle)` →
  `400 handle_invalid` or `400 handle_reserved` on failure.
- Acquire the per-handle mutex (timeout ~500 ms; on timeout
  `503 registration_unavailable`).
- `GetObject(keyHandle(handle))`:
  - `ErrNotFound` → free, proceed.
  - Success → parse body. If carries `released_at` in the future →
    `409 handle_in_cooldown` (body: `released_at` + `available_at`).
    If `released_at` in the past → stale tombstone, `DeleteObject`,
    proceed. Otherwise (live projection) → `409 handle_taken`.
- Generate `user_id`, `device_id`, `token`.
- Write the handle projection. Write the profile. Write the device.
- On any later failure, best-effort `DeleteObject` the handle
  projection to release the handle.
- Release mutex.

The 10-retry random-generator loop ([handlers.go:42-54](../server/handlers.go#L42))
is **deleted**. The server no longer chooses handles. The legacy
`generateHandle` function survives in `server/handle.go` because
the **client** uses it via a separate client-side BIP39 generator
(see step 8 — "Surprise me"), and `server/handle.go` is also where
the new validation logic lives. If the client-side generator
proves sufficient, `generateHandle` can be deleted in a follow-up.

### 6. Resolve handler rewrite

[server/handlers.go](../server/handlers.go) `handleResolve` (the
existing handler):

- Same 404 path for unknown handles.
- For known handles, parse the stored projection. If
  `released_at` is set:
  - In the future → return `410 released` with
    `{ released_at, available_at }`.
  - In the past (stale tombstone) → return `404` (the cleanup
    routine hasn't gotten here yet, but logically the handle is
    free).
- Otherwise return the live 200 projection (existing behaviour).

### 7. Delete-account handler rewrite

Currently `DELETE /v1/profile` removes the handle projection
outright. Change to **rewrite as tombstone**:

```jsonc
{ "released_at": "2026-06-25T10:30:00Z" }
```

Order of operations during deletion (everything else unchanged):

1. Read the user's `profile.json` to find `handle`.
2. Delete `users/{uid}/`, `inbox/{uid}/`, `keys/{uid}/`,
   `media/{uid}/`.
3. `PutObject(keyHandle(handle))` with the tombstone body. The
   per-handle mutex is acquired here too to serialize against any
   in-flight registration on the same handle (rare but possible).

If the server crashes between step 2 and 3, the handle is in S3
but the user is gone. Resolve will fail to look up the user. The
cleanup routine sweeps for orphan handles (projection points at a
non-existent user) and converts them to tombstones too.

### 8. "Surprise me" client-side generator

[web/src/lib/handle-suggest.ts](../web/src/lib/handle-suggest.ts) (new):

```ts
import { wordlist } from '@scure/bip39/wordlists/english.js';

export function suggestHandle(): string {
    const i = crypto.getRandomValues(new Uint16Array(2));
    return `${wordlist[i[0] % 2048]}-${wordlist[i[1] % 2048]}`;
}
```

`@scure/bip39` is already a project dep (used by the legacy
mnemonic login autodetect).

### 9. Registration UI changes

[web/src/components/RegisterForm.tsx](../web/src/components/RegisterForm.tsx):

- Add a handle input field above the password fields.
- Add a "Surprise me" button next to the input that calls
  `suggestHandle()` and fills the input.
- Add a real-time availability indicator:
  - Debounce input by 300 ms.
  - Call `resolve(handle)`:
    - 404 → show "✓ available."
    - 200 → show "✗ taken."
    - 410 → show "✗ in cooldown until YYYY-MM-DD."
  - On charset/length violation: show "✗ invalid (3–32 lowercase
    letters / digits / hyphens, must start with a letter)."
- Disable the Register button until the handle is valid + available
  (or 4xx errors will surface anyway on submit; UI-level gating
  is a friction reducer, not a correctness gate).

[web/src/hooks/useRegister.ts](../web/src/hooks/useRegister.ts):

- Take `handle` from form state.
- Include `handle` in the register payload.
- Map `400 handle_invalid` / `400 handle_reserved` / `409 handle_taken`
  / `409 handle_in_cooldown` / `503 registration_unavailable` to
  user-facing messages.

### 10. URL routing prefix

[web/src/routes/app.tsx](../web/src/routes/app.tsx):

```tsx
<Route path="/@:handle" element={<ChatRoute ... />} />
```

Link construction at all call sites:

- [ChatsView.tsx:147](../web/src/components/ChatsView.tsx#L147):
  ``to={`/@${encodeURIComponent(handle)}`}``
- [chats.tsx:30](../web/src/routes/chats.tsx#L30):
  ``navigate(`/@${encodeURIComponent(handle)}`)``

E2E helper [openChat](../web/e2e/helpers.ts):

```ts
await page.waitForURL(`**/@${handle}`);
```

The `/saved` route stays as it is — it's not a handle.

### 11. API wrapper updates

[web/src/lib/api.ts](../web/src/lib/api.ts):

- `register` request type gains `handle: string`.
- `resolve` return type captures the three states. Suggested
  shape:

```ts
export type ResolveResult =
    | { status: 'live'; user_id: string; sharing_public_key: string; /* salt, kdf, key_version, ... */ }
    | { status: 'not_found' }
    | { status: 'released'; released_at: string; available_at: string };
```

The wrapper dispatches on HTTP status (200 / 404 / 410) and returns
the discriminated union; callers (`useRegister`, `useLogin`,
contact resolution) switch on `status`.

### 12. Cleanup routine extension

The [server-cleanup-routine](server-cleanup-routine.md) task is
already on the queue. This task adds a new sweep target: walk
`handles/*.json`, parse the body, and:

- If `released_at` is set and `released_at + 30d` is in the past →
  `DeleteObject` the tombstone (handle becomes claimable).
- If the projection points at a `user_id` whose `profile.json`
  doesn't exist (orphan) → rewrite as a fresh tombstone with
  `released_at = now`.

Both passes are append-only / idempotent; safe to re-run.

This step requires the server-cleanup-routine task; add a
dependency note in [tasks/README.md](README.md).

## Out of scope

- **Handle rename.** Big enough for its own ADR (old-handle
  reservation, contact-routing during rename, notification). v0.1
  ships immutable handles.
- **Profanity / slur filter.** Per ADR-0013, deliberately out of
  scope. The reserved list is for system-imposter handles, not UGC
  moderation.
- **Discovery / handle search.** Resolving a handle requires
  knowing it. No "search users" endpoint.
- **Cross-instance scaling.** The mutex map is single-instance.
  Multi-instance migration is a future ADR (same one that
  migrates the rotation mutex, the SSE hub, the caches).

## Verify

`make fmt lint test` clean.

**Go handler tests (`handlers_test.go`):**

- Golden registration: valid handle, valid PoW+Turnstile (or test
  mode), 200 with `user_id`, `device_id`, `token`, `handle`.
  Subsequent `GET handles/{handle}.json` returns the live projection.
- `400 handle_invalid` (table-driven):
  - `"ab"` (too short)
  - `"a-very-long-handle-name-that-exceeds-the-maximum-allowed-length"` (too long)
  - `"Alice"` (uppercase)
  - `"al ice"` (space)
  - `"alice_test"` (underscore)
  - `"alice--bot"` (consecutive hyphens)
  - `"-alice"` (leading hyphen)
  - `"alice-"` (trailing hyphen)
  - `"1alice"` (starts with digit — must start with letter)
- `400 handle_reserved` for every entry in `reserved_handles.txt`.
- `409 handle_taken` for a second registration on a claimed handle.
- `409 handle_in_cooldown` for a registration on a handle whose
  tombstone has `released_at` in the future. Body carries
  `released_at` and `available_at`.
- Stale-tombstone reclaim: prime a handle with a tombstone whose
  `released_at + 30d` is in the past. Register succeeds; the
  tombstone is deleted and the live projection takes its place.
- **Concurrent claim serialization (mutex test)**: fire two
  registrations for the same handle in parallel goroutines. Assert
  exactly one returns 200 and the other returns `409 handle_taken`.
- **Different handles do not serialize**: fire concurrent
  registrations for *different* handles; both succeed in parallel
  (regression guard for per-handle, not global, mutex).
- Authorization: the register endpoint is unauthenticated; no auth
  test needed beyond the PoW+Turnstile path covered by ADR-0007's
  task.

**Go resolve tests:**

- `200` with the live projection for a live handle (regression).
- `404` for an unknown handle.
- `410 released` with `released_at` + `available_at` for a
  tombstone-with-future-`released_at`.
- `404` for a tombstone with past `released_at` (the cleanup hasn't
  run, but the handle is logically free).

**Go delete-account test:**

- Account deletion writes the tombstone (not a delete of the
  handle file). Verify the body shape (`released_at` only, no
  `user_id` etc.).
- Resolve after deletion returns `410`. After
  `released_at + 30d`, resolve returns `404` (or the cleanup
  routine has swept the tombstone — both are equivalent
  semantics).

**Mutex tests (`handle_mutex_test.go`):**

- Same matrix as the rotation mutex tests in
  [credential-rotate-endpoint](credential-rotate-endpoint.md):
  no-contention fast path, serialization on same handle, timeout
  on persistent contention, no serialization on different handles,
  map entries reclaimed after release.

**Reserved-handles test:**

- Embedded list loads at init with the expected count.
- `RESERVED_HANDLES_PATH=/tmp/custom.txt` overrides the embedded
  list.

**Vitest:**

- `suggestHandle()` produces strings matching the handle regex
  (sampling N=1000).
- `resolve` wrapper returns the discriminated union correctly for
  200 / 404 / 410.
- `useRegister` posts the handle and surfaces the right error code
  for each 4xx path.

**Storybook:**

- `RegisterForm` with handle field: empty, valid, invalid charset,
  taken, in-cooldown, available, "Surprise me" filled.

**Playwright e2e (`web/e2e/custom-handles.spec.ts`):**

1. Alice registers with `handle = "alice-test"`. URL after redirect
   is `/`.
2. Bob registers with `handle = "alice-test"` → form shows
   "✗ taken." Bob picks `bob-test`, succeeds.
3. Bob opens chat with Alice via "Enter a handle..." input. URL
   becomes `/@alice-test`.
4. Direct URL navigation: load `app.atmin.net/@alice-test` while
   logged in as Bob → chat opens.
5. Bob deletes his account. New context: register `handle = "bob-test"`
   → form shows "✗ in cooldown until YYYY-MM-DD."
6. Try registration with reserved handle `admin` → form shows
   "✗ reserved."
7. Try registration with invalid handles (`Alice`, `al ice`,
   `--bad`, `a`) → form shows charset error.

**Manual:**

- Old browser bookmark at `/alice-test` (without `@`) — 404, no
  silent redirect. (No real bookmarks exist yet since this is
  pre-launch.)
- "Surprise me" button generates a random valid handle on each
  click.
- The handle input has the `@` shown as a leading affordance in
  the input UI (just a CSS prefix character, not part of the
  input value).
