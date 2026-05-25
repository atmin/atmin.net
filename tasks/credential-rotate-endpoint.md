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
the auth-proof-version binding, and the ETag-conditional
`profile.json` write that the higher-level rotation flow needs.

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
- [server/store.go](../server/store.go) `PutObject` does not support
  conditional writes; no ETag plumbing.
- [server/store_mem.go](../server/store_mem.go) `MemStore` has no
  ETag tracking.
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
)
```

`rotateKeys` also returns `409` with the `key_version_stale` code for
the precondition / ETag-race case. Keep one canonical struct but
allow per-call status override (helper `apiErrorWithStatus(err, 409)`)
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

### 6. Store: conditional write

[server/store.go](../server/store.go) `Store` interface gains:

```go
type Store interface {
    // ...existing...
    GetObjectWithETag(ctx context.Context, key string) (body []byte, etag string, err error)
    PutObjectIfMatch(ctx context.Context, key string, body []byte, etag string) (newETag string, err error)
}

var ErrPreconditionFailed = errors.New("precondition failed")
```

S3 implementation passes `If-Match: <etag>` on `PutObject`. AWS SDK
v1 surfaces this as `412 PreconditionFailed`; map to
`ErrPreconditionFailed`.

[server/store_mem.go](../server/store_mem.go): track `etag` per key
(simple `strconv.FormatInt(time.Now().UnixNano(), 36)` or an atomic
counter). `PutObjectIfMatch` compares and increments.

### 7. The `rotateKeys` handler

[server/handlers.go](../server/handlers.go):

```go
type rotateKeysReq struct {
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

    profileBytes, etag, err := s.store.GetObjectWithETag(r.Context(), profileKey(uid))
    if err != nil { /* ... */ }
    var current Profile
    json.Unmarshal(profileBytes, &current)

    currentKV := current.KeyVersion
    if currentKV == 0 { currentKV = 1 }
    if req.KeyVersion != currentKV+1 {
        apiErrWithStatus(w, errKeyVersionStale, 409, map[string]any{"current": currentKV})
        return
    }

    // Verify continuity signature
    canonical, _ := jcs.Transform(continuityBody(req))  // gowebpki/jcs
    oldAuthPub, _ := base64UrlDecode(current.AuthPublicKey)
    sigBytes, _ := base64UrlDecode(req.ContinuitySignature)
    if !ed25519.Verify(oldAuthPub, canonical, sigBytes) {
        apiErr(w, errBadContinuity)
        return
    }

    // Build new profile
    next := current
    next.AuthPublicKey = req.AuthPublicKey
    next.SharingPublicKey = req.SharingPublicKey
    next.Salt = req.Salt
    next.KDF = req.KDF
    next.KeyVersion = req.KeyVersion
    body, _ := json.Marshal(next)

    if _, err := s.store.PutObjectIfMatch(r.Context(), profileKey(uid), body, etag); err != nil {
        if errors.Is(err, ErrPreconditionFailed) {
            apiErrWithStatus(w, errKeyVersionStale, 409, map[string]any{"current": currentKV})
            return
        }
        /* 500 */
    }

    // Write the resolve projection
    handleProj, _ := json.Marshal(projectHandle(&next))
    s.store.PutObject(r.Context(), handleKey(next.Handle), handleProj)

    // Mint new token bound to the new key_version
    token := mintToken(s.cfg.ServerSecret, uid, did, req.KeyVersion)
    writeJSON(w, map[string]any{"token": token, "key_version": req.KeyVersion})
}
```

`continuityBody(req)` returns a `map[string]any` (or struct with
`omitempty` for the sig field) — whatever feeds JCS produces a
canonical byte sequence the client also produces.

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
- `409 key_version_stale` on ETag race — wrap the MemStore to
  return `ErrPreconditionFailed` once, assert mapping to the right
  status + code.
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

**MemStore tests:**

- `PutObjectIfMatch` succeeds on matching ETag, returns new ETag.
- `PutObjectIfMatch` returns `ErrPreconditionFailed` on stale ETag.
- `GetObjectWithETag` returns the value last `Put` and the ETag
  that resulted from that Put.

**Vitest:**

- JCS interop fixture: `canonicalizeForSign(fixture-input)` equals
  the bytes of `jcs-rotation-vector.canonical.txt` (see step 11).
  Mirror assertion exists on the Go side; both must point at the
  same file.
- `rotateKeys` wrapper builds the right request body, throws a typed
  `KeyVersionStaleError` on `401`.

**No e2e in this task.** The rotation flow as a whole is exercised
by task 4's spec.
