# Make MediaQuotaStore cleanly pluggable for future shared-state backend

## Spec
`docs/specs/mvp-v0.1.md` "Per-user quota":
> The quota cache is in-process only, following the same "in-process now, shared-state later" pattern as EventHub. v0.1 runs one container serving all traffic, so a `sync.Map` of `user_id → {usage, expiresAt}` is sufficient. When multi-instance deployment is introduced, the cache moves behind an interface backed by Redis (or equivalent) without changing the presign API.

`docs/decisions/adr-0004-sse-realtime-notifications.md` documents the same pattern for the SSE hub.

## Current
`server/media_quota.go` defines the `MediaQuotaStore` interface with one method (`ReserveUpload`) and an `inProcessMediaQuota` implementation. The interface is satisfied; the implementation is the only one.

Two minor papercuts when we eventually add a Redis-backed implementation:

1. The cache rebuild path (`store.ListObjectSizes` of `media/{uid}/`) is currently coded inside `ReserveUpload`. A Redis-backed store would not call it — but a hybrid store (Redis primary, S3 ground truth on cold start) would. This is fine to leave alone now; the interface gives us the seam.
2. The optimistic increment is *only* reverted on TTL expiry. The spec calls this intentional anti-DoS friction. There is one test (`TestMediaQuota_OptimisticIncrementNotReverted`) that locks this behaviour in. Good — preserve it.
3. Concurrency: `TestMediaQuota_ConcurrentReserveNoLostUpdates` exercises the per-user mutex. Coverage is good. There is no test for **cross-user** concurrency (two users reserving simultaneously must not block each other) — easy to add and locks in the per-entry lock pattern.

This task is small. Land only if you have appetite; otherwise close as "no action".

## Change
1. Add `TestMediaQuota_CrossUserNoSerialisation`: spawn N goroutines reserving for distinct user IDs, with a slow stub `Store.ListObjectSizes` (sleep 50ms). Assert total wall time is much less than `N * 50ms` — i.e. they ran concurrently. This pins the "per-user mutex, not global mutex" behaviour.
2. Add a one-line doc comment on `inProcessMediaQuota` pointing at the spec section and ADR-0004 so future readers find the migration plan: *"v0.1 single-instance store. See docs/specs/mvp-v0.1.md 'Per-user quota' and ADR-0004 for the multi-instance migration plan."*
3. Optional: extract an `s3UsageProbe(ctx, store, userID) (bytes int64, count int, err error)` private function from inside `ReserveUpload`. Pure cosmetic; makes a future Redis-backed store easier to read. Skip if it adds noise.

## Verify
- `cd server && go test ./...` passes including the new test.
- The new test fails reliably (and obviously) if `ReserveUpload` is changed to take a global lock.
