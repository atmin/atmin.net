package main

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// Fixed "now" so age comparisons are deterministic.
var cleanupNow = time.Date(2026, 6, 1, 0, 0, 0, 0, time.UTC)

func ago(d time.Duration) string {
	return cleanupNow.Add(-d).UTC().Format(time.RFC3339)
}

// seedUser writes a handle projection (carrying user_id) + profile, plus any
// live-inbox and media objects, mirroring the real S3 layout.
func seedUser(t *testing.T, store *MemStore, p Profile, inbox, media []string) {
	t.Helper()
	ctx := context.Background()
	if err := putProfile(ctx, store, &p); err != nil {
		t.Fatalf("seed profile: %v", err)
	}
	h, _ := json.Marshal(publicHandleData{UserID: p.UserID})
	if err := store.PutObject(ctx, keyHandle(p.Handle), h, "application/json"); err != nil {
		t.Fatalf("seed handle: %v", err)
	}
	for _, name := range inbox {
		_ = store.PutObject(ctx, prefixInboxLive(p.UserID)+name, []byte("x"), "application/json")
	}
	for _, name := range media {
		_ = store.PutObject(ctx, prefixMedia(p.UserID)+name, []byte("x"), "application/octet-stream")
	}
}

func runCleanupAt(store Store, opts CleanupOpts, now time.Time) (CleanupResult, error) {
	opts.Now = func() time.Time { return now }
	return runCleanup(context.Background(), store, opts)
}

func defaultOpts() CleanupOpts {
	return CleanupOpts{InactiveDays: 180, BatchSize: 100}
}

func exists(store *MemStore, key string) bool {
	_, err := store.GetObject(context.Background(), key)
	return err == nil
}

func countUnder(t *testing.T, store *MemStore, prefix string) int {
	t.Helper()
	keys, _, err := store.ListObjects(context.Background(), prefix, 1000, "")
	if err != nil {
		t.Fatalf("list %s: %v", prefix, err)
	}
	return len(keys)
}

func TestCleanupAbandoned(t *testing.T) {
	store := NewMemStore()
	seedUser(t, store, Profile{
		UserID: "U1", Handle: "alice", CreatedAt: ago(8 * 24 * time.Hour),
	}, nil, nil)

	res, err := runCleanupAt(store, defaultOpts(), cleanupNow)
	if err != nil {
		t.Fatal(err)
	}
	if res.Abandoned != 1 || res.Deleted != 1 {
		t.Fatalf("abandoned=%d deleted=%d, want 1/1", res.Abandoned, res.Deleted)
	}
	if exists(store, keyProfile("U1")) || exists(store, keyHandle("alice")) {
		t.Fatal("user not deleted")
	}
}

func TestCleanupAbandonedWithinGrace(t *testing.T) {
	store := NewMemStore()
	seedUser(t, store, Profile{
		UserID: "U1", Handle: "alice", CreatedAt: ago(6 * 24 * time.Hour),
	}, nil, nil)

	res, _ := runCleanupAt(store, defaultOpts(), cleanupNow)
	if res.Deleted != 0 {
		t.Fatalf("deleted=%d, want 0 (within grace)", res.Deleted)
	}
	if !exists(store, keyProfile("U1")) {
		t.Fatal("user wrongly deleted within grace period")
	}
}

func TestCleanupAbandonedHasMessages(t *testing.T) {
	store := NewMemStore()
	seedUser(t, store, Profile{
		UserID: "U1", Handle: "alice", CreatedAt: ago(8 * 24 * time.Hour),
	}, []string{"01MSG"}, nil)

	res, _ := runCleanupAt(store, defaultOpts(), cleanupNow)
	if res.Deleted != 0 {
		t.Fatalf("deleted=%d, want 0 (has messages)", res.Deleted)
	}
	if !exists(store, keyProfile("U1")) {
		t.Fatal("user with messages wrongly deleted")
	}
}

func TestCleanupAbandonedHasDisplayName(t *testing.T) {
	store := NewMemStore()
	seedUser(t, store, Profile{
		UserID: "U1", Handle: "alice", DisplayName: "Alice",
		CreatedAt: ago(30 * 24 * time.Hour),
	}, nil, nil)

	res, _ := runCleanupAt(store, defaultOpts(), cleanupNow)
	if res.Deleted != 0 {
		t.Fatalf("deleted=%d, want 0 (has display name)", res.Deleted)
	}
}

func TestCleanupInactive(t *testing.T) {
	store := NewMemStore()
	seedUser(t, store, Profile{
		UserID: "U1", Handle: "alice", DisplayName: "Alice",
		CreatedAt: ago(365 * 24 * time.Hour), LastActive: ago(200 * 24 * time.Hour),
	}, nil, nil)

	res, err := runCleanupAt(store, defaultOpts(), cleanupNow)
	if err != nil {
		t.Fatal(err)
	}
	if res.Inactive != 1 || res.Deleted != 1 {
		t.Fatalf("inactive=%d deleted=%d, want 1/1", res.Inactive, res.Deleted)
	}
	if exists(store, keyProfile("U1")) {
		t.Fatal("inactive user not deleted")
	}
}

func TestCleanupActive(t *testing.T) {
	store := NewMemStore()
	seedUser(t, store, Profile{
		UserID: "U1", Handle: "alice", DisplayName: "Alice",
		CreatedAt: ago(365 * 24 * time.Hour), LastActive: ago(30 * 24 * time.Hour),
	}, nil, nil)

	res, _ := runCleanupAt(store, defaultOpts(), cleanupNow)
	if res.Deleted != 0 {
		t.Fatalf("deleted=%d, want 0 (recently active)", res.Deleted)
	}
}

func TestCleanupDryRun(t *testing.T) {
	store := NewMemStore()
	seedUser(t, store, Profile{
		UserID: "U1", Handle: "alice", CreatedAt: ago(8 * 24 * time.Hour),
	}, nil, nil)

	opts := defaultOpts()
	opts.DryRun = true
	res, _ := runCleanupAt(store, opts, cleanupNow)
	if res.Deleted != 1 {
		t.Fatalf("deleted=%d, want 1 (would-delete count)", res.Deleted)
	}
	if !exists(store, keyProfile("U1")) || !exists(store, keyHandle("alice")) {
		t.Fatal("dry-run deleted objects")
	}
}

func TestCleanupBatchSizeLimit(t *testing.T) {
	store := NewMemStore()
	for _, id := range []string{"U1", "U2", "U3", "U4", "U5"} {
		seedUser(t, store, Profile{
			UserID: id, Handle: "h-" + id, CreatedAt: ago(8 * 24 * time.Hour),
		}, nil, nil)
	}

	opts := defaultOpts()
	opts.BatchSize = 2
	res, _ := runCleanupAt(store, opts, cleanupNow)
	if res.Deleted != 2 {
		t.Fatalf("deleted=%d, want exactly 2", res.Deleted)
	}
	if n := countUnder(t, store, "handles/"); n != 3 {
		t.Fatalf("remaining handles=%d, want 3", n)
	}
}

func TestCleanupIdempotent(t *testing.T) {
	store := NewMemStore()
	seedUser(t, store, Profile{
		UserID: "U1", Handle: "alice", CreatedAt: ago(8 * 24 * time.Hour),
	}, nil, nil)

	if _, err := runCleanupAt(store, defaultOpts(), cleanupNow); err != nil {
		t.Fatal(err)
	}
	res2, err := runCleanupAt(store, defaultOpts(), cleanupNow)
	if err != nil {
		t.Fatal(err)
	}
	if res2.Deleted != 0 {
		t.Fatalf("second run deleted=%d, want 0", res2.Deleted)
	}
}

func TestCleanupDeletesAllPrefixes(t *testing.T) {
	store := NewMemStore()
	ctx := context.Background()
	uid := "U1"

	// Inactive user (no inbox-empty requirement), with objects under every prefix.
	seedUser(t, store, Profile{
		UserID: uid, Handle: "alice", DisplayName: "Alice",
		CreatedAt: ago(365 * 24 * time.Hour), LastActive: ago(200 * 24 * time.Hour),
	}, []string{"01MSG"}, []string{"01BLOB"})
	_ = store.PutObject(ctx, keyDevice(uid, "D1"), []byte("{}"), "application/json")
	_ = store.PutObject(ctx, keyRotationRecord(uid, "R1"), []byte("{}"), "application/json")
	_ = store.PutObject(ctx, prefixInboxArchive(uid)+"2026-01-AAA", []byte("x"), "application/cbor")
	_ = store.PutObject(ctx, prefixKeysLive(uid)+"S1", []byte("x"), "application/json")
	_ = store.PutObject(ctx, prefixKeys(uid)+"archive/2026-01-BBB", []byte("x"), "application/cbor")

	if _, err := runCleanupAt(store, defaultOpts(), cleanupNow); err != nil {
		t.Fatal(err)
	}

	for _, prefix := range []string{
		prefixUser(uid), prefixInbox(uid), prefixKeys(uid), prefixMedia(uid),
	} {
		if n := countUnder(t, store, prefix); n != 0 {
			t.Fatalf("prefix %s not empty after cleanup: %d objects", prefix, n)
		}
	}
	if exists(store, keyHandle("alice")) {
		t.Fatal("handle not deleted")
	}
}

func TestCleanupTombstoneWithinCooldown(t *testing.T) {
	store := NewMemStore()
	// A fresh tombstone (within the 30-day cooldown) is left untouched and not
	// counted as an error.
	tomb, _ := json.Marshal(publicHandleData{ReleasedAt: ago(1 * time.Hour)})
	_ = store.PutObject(context.Background(), keyHandle("ghost"), tomb, "application/json")

	res, err := runCleanupAt(store, defaultOpts(), cleanupNow)
	if err != nil {
		t.Fatal(err)
	}
	if res.Deleted != 0 || res.Errors != 0 {
		t.Fatalf("deleted=%d errors=%d, want 0/0 within cooldown", res.Deleted, res.Errors)
	}
	if !exists(store, keyHandle("ghost")) {
		t.Fatal("in-cooldown tombstone wrongly deleted")
	}
}

func TestCleanupExpiredTombstone(t *testing.T) {
	store := NewMemStore()
	// A tombstone past releasedAt + 30-day cooldown is dead weight — swept.
	tomb, _ := json.Marshal(publicHandleData{ReleasedAt: ago(31 * 24 * time.Hour)})
	_ = store.PutObject(context.Background(), keyHandle("ghost"), tomb, "application/json")

	res, err := runCleanupAt(store, defaultOpts(), cleanupNow)
	if err != nil {
		t.Fatal(err)
	}
	if res.Tombstones != 1 || res.Deleted != 1 {
		t.Fatalf("tombstones=%d deleted=%d, want 1/1", res.Tombstones, res.Deleted)
	}
	if exists(store, keyHandle("ghost")) {
		t.Fatal("expired tombstone not swept")
	}
}

func TestCleanupExpiredTombstoneDryRun(t *testing.T) {
	store := NewMemStore()
	tomb, _ := json.Marshal(publicHandleData{ReleasedAt: ago(31 * 24 * time.Hour)})
	_ = store.PutObject(context.Background(), keyHandle("ghost"), tomb, "application/json")

	opts := defaultOpts()
	opts.DryRun = true
	res, _ := runCleanupAt(store, opts, cleanupNow)
	if res.Tombstones != 1 || res.Deleted != 1 {
		t.Fatalf("tombstones=%d deleted=%d, want 1/1", res.Tombstones, res.Deleted)
	}
	if !exists(store, keyHandle("ghost")) {
		t.Fatal("dry-run swept the tombstone")
	}
}
