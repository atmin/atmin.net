package main

import (
	"context"
	"log"
	"sync"
	"time"
)

const (
	MAX_MEDIA_BYTES        = 25 * 1024 * 1024 // 25 MiB per blob
	USER_MEDIA_QUOTA_BYTES = 1 << 30          // 1 GiB per user
	USER_MEDIA_BLOB_CAP    = 1000             // one ListObjectsV2 page
	QUOTA_CACHE_TTL        = 10 * time.Minute
)

// MediaQuotaStore tracks per-user media usage. The v0.1 implementation is
// in-process (see EventHub precedent and
// docs/decisions/adr-0004-sse-realtime-notifications.md#redis-pubsub-from-day-one);
// a Redis-backed implementation can swap in later without handler changes.
type MediaQuotaStore interface {
	// ReserveUpload checks quota+cap and optimistically increments usage.
	// Returns (ok=true) when the upload is permitted. On deny, `reason`
	// distinguishes "quota_exceeded_bytes", "quota_exceeded_count"
	// (both surface to clients as the same 413 quota_exceeded).
	ReserveUpload(ctx context.Context, userID string, bytes int64) (ok bool, reason string, err error)

	// Invalidate drops the cached usage for a user so the next ReserveUpload
	// re-probes S3 for exact usage. Called after a media delete — the handler
	// has only the key, not the blob's byte size, so it can't decrement
	// precisely; eagerly invalidating closes the stale-overcount window to
	// "until the next upload" instead of the full cache TTL.
	Invalidate(userID string)
}

type quotaEntry struct {
	mu         sync.Mutex
	usageBytes int64
	blobCount  int
	expiresAt  time.Time
}

// inProcessMediaQuota is the v0.1 single-instance store.
// See docs/specs/mvp-v0.1.md "Per-user quota" and ADR-0004 for the multi-instance migration plan.
type inProcessMediaQuota struct {
	store   Store
	entries sync.Map // userID -> *quotaEntry
	now     func() time.Time
}

func NewMediaQuota(store Store) *inProcessMediaQuota {
	return &inProcessMediaQuota{store: store, now: time.Now}
}

func s3UsageProbe(ctx context.Context, store Store, userID string) (totalBytes int64, count int, err error) {
	prefix := prefixMedia(userID)
	total, n, truncated, err := store.ListObjectSizes(ctx, prefix, USER_MEDIA_BLOB_CAP)
	if err != nil {
		return 0, 0, err
	}
	if truncated {
		log.Printf("media_quota.list_truncated user=%s count=%d", userID, n)
	}
	return total, n, nil
}

func (q *inProcessMediaQuota) ReserveUpload(ctx context.Context, userID string, bytes int64) (bool, string, error) {
	v, _ := q.entries.LoadOrStore(userID, &quotaEntry{})
	e := v.(*quotaEntry)
	e.mu.Lock()
	defer e.mu.Unlock()

	if q.now().After(e.expiresAt) {
		total, count, err := s3UsageProbe(ctx, q.store, userID)
		if err != nil {
			return false, "", err
		}
		e.usageBytes = total
		e.blobCount = count
		e.expiresAt = q.now().Add(QUOTA_CACHE_TTL)
	}

	if e.blobCount+1 > USER_MEDIA_BLOB_CAP {
		return false, "quota_exceeded_count", nil
	}
	if e.usageBytes+bytes > USER_MEDIA_QUOTA_BYTES {
		return false, "quota_exceeded_bytes", nil
	}
	// Optimistic increment; not reverted on unused presigns, rebuilt on TTL refresh.
	e.usageBytes += bytes
	e.blobCount++
	return true, "", nil
}

// Invalidate expires a user's cached entry (if present) so the next
// ReserveUpload re-probes S3. Cheap: no S3 call here, no extra allocation —
// the re-probe is work ReserveUpload would do at TTL expiry anyway.
func (q *inProcessMediaQuota) Invalidate(userID string) {
	v, ok := q.entries.Load(userID)
	if !ok {
		return
	}
	e := v.(*quotaEntry)
	e.mu.Lock()
	e.expiresAt = time.Time{}
	e.mu.Unlock()
}
