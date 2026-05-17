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
}

type quotaEntry struct {
	mu         sync.Mutex
	usageBytes int64
	blobCount  int
	expiresAt  time.Time
}

type inProcessMediaQuota struct {
	store   Store
	entries sync.Map // userID -> *quotaEntry
	now     func() time.Time
}

func NewMediaQuota(store Store) *inProcessMediaQuota {
	return &inProcessMediaQuota{store: store, now: time.Now}
}

func (q *inProcessMediaQuota) ReserveUpload(ctx context.Context, userID string, bytes int64) (bool, string, error) {
	v, _ := q.entries.LoadOrStore(userID, &quotaEntry{})
	e := v.(*quotaEntry)
	e.mu.Lock()
	defer e.mu.Unlock()

	if q.now().After(e.expiresAt) {
		prefix := prefixMedia(userID)
		total, count, truncated, err := q.store.ListObjectSizes(ctx, prefix, USER_MEDIA_BLOB_CAP)
		if err != nil {
			return false, "", err
		}
		if truncated {
			// Cap enforcement should prevent this from ever happening.
			log.Printf("media_quota.list_truncated user=%s count=%d", userID, count)
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
