# Credential overhaul 2/5 — `POST /v1/rotate-keys` endpoint

Part of the credential-overhaul task group:

1. [credential-registration](credential-registration.md) — registration UI + Argon2id + salt
2. **credential-rotate-endpoint** (this file) — server `POST /v1/rotate-keys`
3. [credential-backup-chain](credential-backup-chain.md) — `key_chain.json` + envelope versioning
4. [credential-rotate-ui](credential-rotate-ui.md) — settings UI for "change password"
5. [credential-multi-device-cutoff](credential-multi-device-cutoff.md) — handle `401 key_version_stale`

## Motivation

Server-side primitive for credential rotation. No UI in this task —
that's task 4. This adds the endpoint, the token-version binding,
the auth-proof-version binding, the per-`user_id` mutex that
serializes the GET-VERIFY-WRITE on `profile.json`, and the
idempotency record store that dedups retries. The production
backend doesn't offer conditional writes
([ops.md — Object storage constraints](../docs/ops.md#object-storage-constraints)),
so the mutex is the only correct way to close the rotation race.

Lands in parallel with task 1 (registration). They share no code.

Specs: [ADR-0012](../docs/decisions/adr-0012-backup-secret-rotation.md),
[mvp-v0.1.md#rotate-keys](../docs/specs/mvp-v0.1.md#rotate-keys),
[mvp-v0.1.md#auth](../docs/specs/mvp-v0.1.md#auth),
[mvp-v0.1.md#auth-proof](../docs/specs/mvp-v0.1.md#auth-proof).

## Current state

- [server/handlers.go](../server/handlers.go) has no `rotateKeys`
  handler.
- [server/middleware.go](../server/middleware.go) `requireAuth`
  validates token HMAC but does not look at `key_version`.
- [server/auth.go](../server/auth.go) verifies auth-proof v1
  (`{user_id, device_id, timestamp}`) via `JSON.stringify` byte
  match. No JCS, no `key_version`.
- [server/store.go](../server/store.go) — no conditional write
  primitive. Not needed; the mutex closes the race instead (see
  [ops.md](../docs/ops.md#object-storage-constraints)).
- The server today has no in-process mutex map for per-`user_id`
  serialization. The existing in-process state lives in the SSE
  hub, the device-existence cache, and the media-quota cache.
- [web/src/lib/api.ts](../web/src/lib/api.ts) has no `rotateKeys`
  wrapper.

## Architecture constraints

- `slog` for logs (no `fmt.Println`), text format per
  [ADR-0010](../docs/decisions/adr-0010-logging.md).
- Errors: use the canonical `APIError` set in `error.go`. Add new
  values rather than open-coding strings at the call site.
- Authorization is per-prefix in `handlers.go`. `rotate-keys`
  modifies `users/{user_id}/profile.json` — already covered by the
  existing prefix allow-list for the caller's own UID.

## Change

### 1. Dependencies

Server: `cd server && go get github.com/gowebpki/jcs`.

Client `canonicalize` is added by [task 1](credential-registration.md)
(it ships `canonicalizeForSign` + `signAuthProofV2` for the v2
auth-proof path). This task reuses the same helper.

### 2. Error model

[server/error.go](../server/error.go):

```go
var (
    errKeyVersionStale = APIError{401, "key_version_stale", "Token or auth proof bound to a superseded key_version"}
    errBadContinuity   = APIError{403, "bad_continuity", "Continuity signature did not verify"}
    // 503 reserved for the multi-instance future; single-instance never emits it.
)
```

`rotateKeys` also returns `409` with the `key_version_stale` code on
the `request.key_version != current+1` precondition. Keep one
canonical struct but allow per-call status override
(helper `apiErrorWithStatus(err, 409)`)
or define a second var. Pick whichever matches the existing pattern
better.

### 3. Token format v2

[server/auth.go](../server/auth.go) — update `mintToken` and
`parseToken`:

- Token wire format:
  `base64url(uid || "." || did || "." || kv || "." || HMAC(secret, uid || "." || did || "." || kv))`
- `parseToken` accepts both v1 (3 segments) and v2 (4 segments).
  Returns `(uid, did, keyVersion, error)` — v1 yields `keyVersion = 1`.
- `mintToken(uid, did, keyVersion)` always emits v2.

The HMAC covers `key_version` so an attacker cannot bump a stolen
token's version.

### 4. Auth middleware key-version check

[server/middleware.go](../server/middleware.go) `requireAuth`:

After existing HMAC + device-existence checks, add:

```go
profile, err := s.store.GetProfile(ctx, uid)
if err != nil { /* 500 */ }
currentKV := profile.KeyVersion
if currentKV == 0 { currentKV = 1 }  // legacy v1
if tokenKV != currentKV {
    writeJSONStatus(w, errKeyVersionStale, map[string]any{"current": currentKV})
    return
}
```

Cache the profile lookup the same way `deviceCache` caches device
existence — short TTL, keyed by `uid`. The cache is invalidated when
`rotate-keys` writes; either via TTL expiry on other servers (small
window of stale acceptance, acceptable) or by emitting an event.
TTL-only is fine.

### 5. Auth-proof v2 with JCS

[server/auth.go](../server/auth.go) — extend the existing payload
verifier:

```go
type AuthProofPayloadV2 struct {
    UserID     string `json:"user_id"`
    DeviceID   string `json:"device_id"`
    Timestamp  string `json:"timestamp"`
    KeyVersion int    `json:"key_version"`
}

func verifyAuthProof(pub ed25519.PublicKey, raw json.RawMessage, sig []byte) error {
    // Try v2 first: JCS-canonicalize and verify
    // If signature fails AND raw has no key_version field, fall back to v1
    //   (legacy JSON.stringify byte sequence)
}
```

v1 verification keeps the existing byte sequence (currently `JSON.marshal`
output of the v1 struct). Do not regenerate v1 proofs in code.

Also: in the v2 path, after sig verification succeeds, compare the
payload's `key_version` against the current profile's; mismatch is
`401 key_version_stale` (not a verification error).

### 6. Per-`user_id` rotation mutex

A new file `server/rotation_mutex.go` (or inline in `handlers.go`,
~30 LoC):

```go
type rotationMutexMap struct {
    mu sync.Mutex
    m  map[string]*rotationLock
}

type rotationLock struct {
    mu       sync.Mutex
    refCount int
}

// acquireRotation returns a function the caller must call to release.
// Blocks up to timeout; returns errRotationContention on timeout.
func (rm *rotationMutexMap) acquire(userID string, timeout time.Duration) (release func(), err error)
```

Implementation:

- `acquire` looks up or creates the `*rotationLock` for `userID`,
  increments `refCount`, then attempts `lock.mu.Lock()` with a
  timeout (via a `sync.Mutex` + `chan` trick or
  `golang.org/x/sync/semaphore`).
- The returned `release` unlocks and decrements; when `refCount`
  reaches zero, the entry is deleted from the map (small periodic
  sweep for safety).
- The mutex is intentionally local to this server process. See
  [ADR-0012 — Concurrency control](../docs/decisions/adr-0012-backup-secret-rotation.md)
  for the multi-instance migration story.

Lives next to the existing in-process state (device-existence
cache, media-quota cache, SSE hub).

### 7. Idempotency record store

The rotation request gains a `request_id` field (UUID v4). The
server records every completed rotation outcome under
`users/{user_id}/rotation-records/{request_id}.json` as:

```jsonc
// success
{ "status": 200, "token": "...", "key_version": 2 }
// failure
{ "status": 409, "error": "key_version_stale", "current": 1 }
```

The record carries a 24-hour TTL (cleaned up by the
[server-cleanup-routine](server-cleanup-routine.md) task — sweeps
`users/*/rotation-records/*.json` older than 24h).

Helper functions in `server/idempotency.go`:

```go
// Returns (cachedResponse, ok). If ok, replay the cachedResponse verbatim.
func loadRotationRecord(ctx context.Context, store Store, uid, requestID string) (*RotationRecord, bool, error)
func saveRotationRecord(ctx context.Context, store Store, uid, requestID string, rec RotationRecord) error
```

### 8. The `rotateKeys` handler

[server/handlers.go](../server/handlers.go):

```go
type rotateKeysReq struct {
    RequestID           string     `json:"request_id"`            // idempotency key
    KeyVersion          int        `json:"key_version"`
    AuthPublicKey       string     `json:"auth_public_key"`
    SharingPublicKey    string     `json:"sharing_public_key"`
    Salt                string     `json:"salt"`
    KDF                 *KDFParams `json:"kdf"`
    ContinuitySignature string     `json:"continuity_signature"`
}

func (s *server) rotateKeys(w http.ResponseWriter, r *http.Request) {
    uid := uidFromContext(r.Context())
    did := didFromContext(r.Context())

    var req rotateKeysReq
    if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
        apiErr(w, errBadRequest)
        return
    }
    if !validUUID(req.RequestID) {
        apiErr(w, errBadRequest)
        return
    }

    // 1. Acquire per-user_id mutex
    release, err := s.rotationMu.acquire(uid, 500*time.Millisecond)
    if err != nil {
        // Single-instance: contention with self — return 409 (genuine concurrent
        //   rotation, not unavailable). Future multi-instance: 503 unavailable.
        apiErrWithStatus(w, errKeyVersionStale, 409, map[string]any{"current": -1})
        return
    }
    defer release()

    // 2. Idempotency: replay if seen
    if rec, ok, _ := loadRotationRecord(r.Context(), s.store, uid, req.RequestID); ok {
        writeJSONStatus(w, rec.Status, rec.Body())
        return
    }

    // 3. Read current profile
    profileBytes, err := s.store.GetObject(r.Context(), profileKey(uid))
    if err != nil { /* 500 */ }
    var current Profile
    json.Unmarshal(profileBytes, &current)

    currentKV := current.KeyVersion
    if currentKV == 0 { currentKV = 1 }
    if req.KeyVersion != currentKV+1 {
        rec := RotationRecord{Status: 409, Error: "key_version_stale", Current: currentKV}
        saveRotationRecord(r.Context(), s.store, uid, req.RequestID, rec)
        apiErrWithStatus(w, errKeyVersionStale, 409, map[string]any{"current": currentKV})
        return
    }

    // 4. Verify continuity signature
    canonical, _ := jcs.Transform(continuityBody(req)) // gowebpki/jcs
    oldAuthPub, _ := base64UrlDecode(current.AuthPublicKey)
    sigBytes, _ := base64UrlDecode(req.ContinuitySignature)
    if !ed25519.Verify(oldAuthPub, canonical, sigBytes) {
        rec := RotationRecord{Status: 403, Error: "bad_continuity"}
        saveRotationRecord(r.Context(), s.store, uid, req.RequestID, rec)
        apiErr(w, errBadContinuity)
        return
    }

    // 5. Build & write new profile (unconditional — mutex makes it atomic for this uid)
    next := current
    next.AuthPublicKey = req.AuthPublicKey
    next.SharingPublicKey = req.SharingPublicKey
    next.Salt = req.Salt
    next.KDF = req.KDF
    next.KeyVersion = req.KeyVersion
    body, _ := json.Marshal(next)
    if err := s.store.PutObject(r.Context(), profileKey(uid), body, "application/json"); err != nil {
        /* 500; do NOT save record (let the client retry) */
        return
    }

    // 6. Write resolve projection
    handleProj, _ := json.Marshal(projectHandle(&next))
    s.store.PutObject(r.Context(), handleKey(next.Handle), handleProj, "application/json")

    // 7. Mint new token + save idempotency record
    token := mintToken(s.cfg.ServerSecret, uid, did, req.KeyVersion)
    rec := RotationRecord{Status: 200, Token: token, KeyVersion: req.KeyVersion}
    saveRotationRecord(r.Context(), s.store, uid, req.RequestID, rec)
    writeJSON(w, map[string]any{"token": token, "key_version": req.KeyVersion})
}
```

`continuityBody(req)` strips `continuity_signature` from the
request body and feeds the rest into JCS. The client builds the
exact same map; both sides produce identical bytes.

Note on `RequestID` and the continuity signature: `RequestID` is
**included** in the JCS-canonicalized payload covered by the
signature. An attacker who replays a captured rotation body
reuses the recorded outcome (idempotent replay), but the recorded
outcome includes a token bound to the original `device_id` via
HMAC — useless on a different device.

### 8. Route registration

[server/routes.go](../server/routes.go):

```go
mux.HandleFunc("POST /v1/rotate-keys", s.requireAuth(s.rotateKeys))
```

### 9. Client API wrapper

[web/src/lib/api.ts](../web/src/lib/api.ts):

```ts
export interface RotateKeysReq {
    key_version: number;
    auth_public_key: string;
    sharing_public_key: string;
    salt: string;
    kdf: KdfParams;
    continuity_signature: string;
}

export interface RotateKeysRes {
    token: string;
    key_version: number;
}

export async function rotateKeys(token: string, req: RotateKeysReq): Promise<RotateKeysRes> {
    // POST with bearer token, return parsed body
    // On 401 key_version_stale, throw a typed error so the caller can react
}
```

### 10. Client continuity-sign helper

[web/src/lib/crypto.ts](../web/src/lib/crypto.ts) adds:

```ts
export async function signContinuity(
    privateKey: CryptoKey,
    bodyWithoutSig: Record<string, unknown>,
): Promise<Uint8Array> {
    const data = canonicalizeForSign(bodyWithoutSig);  // helper from Task 1
    return new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data),
    );
}
```

Reuses `canonicalizeForSign` already added by task 1. The actual
*caller* of `signContinuity` lands in task 4 (the rotation UI);
this task just provides the helper alongside the API wrapper.

### 11. JCS interop fixture

A single canonical JSON fixture asserted on both sides keeps the
TS and Go implementations from silently diverging.

New `web/e2e/fixtures/jcs-rotation-vector.json` — a representative
rotation request body (without `continuity_signature`) using nested
objects, mixed key orderings, and string escapes that exercise the
RFC 8785 ordering rules.

New `web/e2e/fixtures/jcs-rotation-vector.canonical.txt` — the
expected canonical byte sequence (LF-terminated, raw UTF-8).

Tests on both sides load these fixtures and assert their respective
JCS implementation produces the expected bytes:

- `web/src/lib/crypto.test.ts` adds a case using
  `canonicalizeForSign` on the fixture, asserting byte-equality
  with the `.canonical.txt`.
- `server/auth_test.go` (or a new `server/jcs_test.go`) adds the
  same assertion using `jcs.Transform`.

If a future library upgrade on either side breaks RFC 8785
conformance, both halves of the rotation flow would otherwise
silently disagree on the signed bytes — and the symptom would be
"every rotation returns `403 bad_continuity`" with no obvious
locus. This fixture is the cheapest catch.

## Out of scope

- The UI that calls this endpoint (task 4).
- Writing `key_chain.json` (task 3).
- Client-side detection of `key_version_stale` and forced re-login
  (task 5).
- Re-encrypting historical key-backup blobs (none of the above —
  spec mandates lazy chain walking, never eager re-encrypt).
- `addDevice` / `revokeDevice` v2 auth-proof generation on the
  client. They keep producing v1 proofs until task 4 also updates
  the device flows for v2 accounts.

## Verify

`make fmt lint test` clean.

**Go handler tests (`handlers_test.go`):**

- Golden rotation: register v2 account, call rotate-keys with valid
  continuity sig and `key_version = 2`, assert response has new
  token + `key_version: 2`; assert `profile.json` round-trips with
  new pubkeys, new salt, new kdf, `key_version: 2`; assert
  **`handles/{handle}.json` (the resolve projection) reflects the
  same new public fields**; assert `GET /v1/resolve/{handle}`
  returns the new `sharing_public_key`, new `salt`, new `kdf`,
  `key_version: 2`; assert old token now returns
  `401 key_version_stale`.
- v1 token rejected on rotated account: register v2 account, capture
  the v1-format token a hypothetical legacy client might have
  produced (3 segments, no `key_version`), rotate to v2, send any
  authenticated request with the v1-format token, assert
  `401 key_version_stale` (not `401 unauthorized`). The same
  scenario with a fresh v1 account at `key_version: 1` should
  succeed — v1 tokens against unrotated accounts continue to work.
- `403 bad_continuity` when the signature is over a different body
  than the request claims.
- `409 key_version_stale` when `req.key_version != current+1`
  (try `current`, try `current+2`).
- **Concurrent rotation serialization (mutex test)**: fire two
  rotation requests for the same `user_id` concurrently via
  `httptest` (e.g. spawn two goroutines hitting the handler).
  Assert exactly one returns 200 with `key_version: 2` and the
  other returns `409 key_version_stale` with `current: 2`. Repeat
  for two *different* `user_id`s to confirm the mutex is
  per-user, not global.
- **Idempotent replay**: rotate with `request_id = X`, capture the
  200 response. Re-submit the *same* request bytes (same
  `request_id`, same continuity sig, same payload). Assert the
  handler returns the recorded 200 verbatim without re-running
  the rotation — in particular, `profile.json` is not rewritten
  (verify via store call counter or ETag in MemStore).
- **Idempotent replay of failure**: same with a request that
  fails `key_version_stale`. The replay returns the same 409 with
  the same `current` field.
- **Concurrent retry race (mutex + idempotency together)**: fire
  the same `request_id` twice concurrently. Assert both return
  the same 200, exactly one rotation write happened, exactly one
  idempotency record was written.
- v1-to-v2 first rotation: register a v1 account directly via
  `MemStore`, call rotate-keys with `key_version: 2`, assert the
  new profile carries `Salt`, `KDF`, `KeyVersion`.
- Authorization: caller A cannot rotate caller B's keys.

**Go auth tests:**

- `parseToken` round-trips v1 (3 segments → `kv = 1`) and v2 (4
  segments → embedded `kv`).
- `mintToken` always emits v2.
- A v2 token with tampered `kv` segment fails HMAC verification.
- `verifyAuthProof` accepts v1 payload (no `key_version` field,
  legacy byte sequence) and v2 payload (with `key_version`, JCS
  byte sequence).
- Auth proof rejection on `key_version` mismatch returns
  `key_version_stale`, not the verification error.

**Rotation mutex tests (`rotation_mutex_test.go`):**

- `acquire` returns immediately when no contention.
- `acquire` serializes two goroutines on the same `user_id`: the
  second blocks until the first releases.
- `acquire` returns an error after `timeout` if contention persists.
- Different `user_id`s do not serialize (regression guard).
- `acquire` cleans up the map entry after the final `release`
  (no goroutine leak, no memory growth across many handles).

**Idempotency tests (`idempotency_test.go`):**

- `saveRotationRecord` + `loadRotationRecord` round-trip.
- `loadRotationRecord` returns `ok: false` for an unknown
  `request_id`.
- Records expire (cleanup sweep), assertion: a record written
  >24h ago is removed by the sweep function.

**Vitest:**

- JCS interop fixture: `canonicalizeForSign(fixture-input)` equals
  the bytes of `jcs-rotation-vector.canonical.txt` (see step 11).
  Mirror assertion exists on the Go side; both must point at the
  same file.
- `rotateKeys` wrapper builds the right request body, throws a typed
  `KeyVersionStaleError` on `401`.
- The client generates a fresh `request_id` (UUID v4) per rotation
  attempt; retries of the same attempt reuse the same
  `request_id`. Test by mocking the network layer to fail once,
  observing the retry carries the same `request_id`.

**No e2e in this task.** The rotation flow as a whole is exercised
by task 4's spec.
