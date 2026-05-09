# Cover the untested server paths: handleDeleteDevice, requireAuth middleware, /v1/send idempotency

## Spec
- `docs/specs/mvp-v0.1.md` "Auth": token in `Authorization: Bearer …` or query parameter (for SSE only). Revocation check is HEAD on `users/{uid}/devices/{did}.json`; missing file → `403 device_revoked`. Cache TTL is short (currently 30s in `server/middleware.go`).
- `docs/specs/mvp-v0.1.md` "Reliability & idempotency": `msg_id` is a ULID; client retries are allowed; server may overwrite the same inbox key with identical content.
- `docs/scenarios/stolen-device.md` and `docs/scenarios/invalid-token.md` document the revoke and 401 paths from a client perspective.

## Current
`server/handlers_test.go` and `server/auth_test.go` cover token round-trip and most handlers, but three gaps remain:

1. **`handleDeleteDevice` (DELETE /v1/devices) has zero tests.** Wired in `server/routes.go`; implemented in `server/handlers.go`. Used by `useSession.handleLogout` on every logout.

2. **`requireAuth` middleware behaviour is not directly tested.** The token round-trip is tested in `server/auth_test.go`, but the middleware contract is uncovered:
   - Token via `Authorization: Bearer` vs token via `?token=` query parameter (the latter exists for `EventSource`).
   - Missing token → 401 with `error: unauthorized`.
   - Malformed token → 401.
   - Valid token but device file missing → 403 with `error: device_revoked`.
   - Device cache: a successful auth populates the cache; a subsequent revoke calls `cache.invalidate(deviceKey)`, and the next request observes 403 immediately (not after the 30s TTL).
   - HEAD failure that is **not** `ErrNotFound` → 500 `internal`.

3. **`/v1/send` idempotency is asserted by spec but not by test.** No Go test sends the same `msg_id` twice and checks state.

## Current
`server/handlers_test.go` already has helpers (`testServer`, `registerTestUser`, `signAuthProof`, `authedRequest`) — reuse them.

## Change
Add tests, all using `MemStore`. Group naturally by file:

In `server/handlers_test.go`:
- `TestDeleteDevice_Self`: register Alice, call `DELETE /v1/devices` with her token, assert 200, assert device file is gone in the store, assert subsequent authed call returns 403 `device_revoked`.
- `TestSendIdempotent_SameMsgID`: send envelope `{msg_id: M, content: "hello"}` to self, then send envelope `{msg_id: M, content: "hello"}` again. Assert exactly one object exists at `inbox/{uid}/live/M` and its body matches the second write (overwrite is fine; the contract is "no duplicate inbox keys"). Bonus assertion: SSE `Notify` is called twice (the spec does not promise dedup of notifications).

Create `server/middleware_test.go`:
- `TestRequireAuth_HeaderToken`: valid Bearer header → handler runs, sees `userIDFrom(ctx)` populated.
- `TestRequireAuth_QueryToken`: valid `?token=…` query param, no header → handler runs (path in spec for SSE).
- `TestRequireAuth_NoToken`: no header, no query → 401 `unauthorized`.
- `TestRequireAuth_MalformedToken`: garbage in header → 401 `unauthorized`.
- `TestRequireAuth_DeviceRevoked`: valid token whose device file does not exist → 403 `device_revoked`.
- `TestRequireAuth_RevocationInvalidatesCache`: register; first request populates cache; delete the device file directly via `store.DeleteObject` **and** `cache.invalidate(deviceKey)`; second request returns 403 immediately. (Without `invalidate`, the cached entry would let the request through for up to 30s — this is the contract that justifies why `handleRevokeDevice` calls `cache.invalidate`.)
- `TestRequireAuth_HeadStoreError`: use a stub `Store` (or extend `MemStore` with an injectable error) that returns a non-`ErrNotFound` error from `HeadObject` → 500 `internal`.
- `TestRemoteIP_XFFParsing`: small table-driven test for `remoteIP`: bare RemoteAddr, `X-Forwarded-For: 1.2.3.4`, `X-Forwarded-For: 1.2.3.4, 5.6.7.8` (must return `1.2.3.4`), `X-Forwarded-For:    1.2.3.4   ,5.6.7.8` (must trim).

For the `MemStore` HEAD-error injection, the smallest change is a flag on `MemStore` like `headErr error` consulted in `HeadObject` if non-nil. Document it in `store_mem.go`.

## Verify
- `cd server && go test ./...` passes with the new tests.
- `go test -run 'TestRequireAuth|TestDeleteDevice_Self|TestSendIdempotent|TestRemoteIP' ./...` confirms each individual test name resolves.
