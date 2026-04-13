package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// --- handleStoreObject: Cache-Control for media/ ---

func TestStoreObject_MediaSetsCacheControl(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	key := "media/" + alice.UserID + "/01HELLO/photo.bin"
	store.PutObject(context.Background(), key, []byte("ciphertext"), "application/octet-stream")

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET", "/v1/store/object?key="+key, alice.Token, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d; body = %s", w.Code, w.Body.String())
	}
	got := w.Header().Get("Cache-Control")
	want := "private, immutable, max-age=31536000"
	if got != want {
		t.Fatalf("Cache-Control = %q, want %q", got, want)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/octet-stream" {
		t.Fatalf("Content-Type = %q, want application/octet-stream", ct)
	}
}

func TestStoreObject_InboxNoCacheControl(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	key := "inbox/" + alice.UserID + "/live/01MSG"
	store.PutObject(context.Background(), key, []byte("{}"), "application/json")

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET", "/v1/store/object?key="+key, alice.Token, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	if cc := w.Header().Get("Cache-Control"); cc != "" {
		t.Fatalf("Cache-Control = %q, want empty for inbox key", cc)
	}
}

// --- presign: size cap ---

func TestPresign_TooLarge(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	body, _ := json.Marshal(map[string]any{
		"key":   "media/" + alice.UserID + "/01BIG/blob",
		"bytes": MAX_MEDIA_BYTES + 1,
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/presign", alice.Token, string(body)))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body = %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["error"] != "too_large" {
		t.Fatalf("error = %q, want too_large", resp["error"])
	}
}

func TestPresign_AtMaxSizeAllowed(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	body, _ := json.Marshal(map[string]any{
		"key":   "media/" + alice.UserID + "/01AT/blob",
		"bytes": MAX_MEDIA_BYTES,
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/presign", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200; body = %s", w.Code, w.Body.String())
	}
}

// --- presign: quota ---

func presignReq(userID string, bytes int64) string {
	b, _ := json.Marshal(map[string]any{
		"key":   "media/" + userID + "/" + randSuffix() + "/blob",
		"bytes": bytes,
	})
	return string(b)
}

var suffixCounter int64

func randSuffix() string {
	n := atomic.AddInt64(&suffixCounter, 1)
	return "u" + time.Now().Format("150405.000000") + "-" + itoa(n)
}

func itoa(n int64) string {
	if n == 0 {
		return "0"
	}
	var buf [20]byte
	i := len(buf)
	neg := n < 0
	if neg {
		n = -n
	}
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

func TestPresign_QuotaExceeded(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Seed ~1 GiB across a few existing blobs.
	chunk := make([]byte, 1<<28) // 256 MiB
	for i := 0; i < 4; i++ {
		key := "media/" + alice.UserID + "/existing" + itoa(int64(i)) + "/blob"
		store.PutObject(context.Background(), key, chunk, "application/octet-stream")
	}

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/presign", alice.Token,
		presignReq(alice.UserID, 1)))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body = %s", w.Code, w.Body.String())
	}
	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["error"] != "quota_exceeded" {
		t.Fatalf("error = %q, want quota_exceeded", resp["error"])
	}
}

func TestPresign_BlobCountCap(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	for i := 0; i < USER_MEDIA_BLOB_CAP; i++ {
		key := "media/" + alice.UserID + "/b" + itoa(int64(i)) + "/blob"
		store.PutObject(context.Background(), key, []byte("x"), "application/octet-stream")
	}

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/presign", alice.Token,
		presignReq(alice.UserID, 1)))
	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413; body = %s", w.Code, w.Body.String())
	}
}

// --- MediaQuotaStore unit tests (direct) ---

func TestMediaQuota_OptimisticIncrementNotReverted(t *testing.T) {
	store := NewMemStore()
	q := NewMediaQuota(store)
	ctx := context.Background()

	ok, _, err := q.ReserveUpload(ctx, "alice", 100)
	if err != nil || !ok {
		t.Fatalf("first reserve: ok=%v err=%v", ok, err)
	}
	// Do NOT upload. Second reserve within TTL should see usage=100.
	ok, _, err = q.ReserveUpload(ctx, "alice", 100)
	if err != nil || !ok {
		t.Fatalf("second reserve: ok=%v err=%v", ok, err)
	}
	e, _ := q.entries.Load("alice")
	got := e.(*quotaEntry).usageBytes
	if got != 200 {
		t.Fatalf("usageBytes = %d, want 200 (optimistic increments persist across presigns)", got)
	}
}

func TestMediaQuota_CacheTTL(t *testing.T) {
	store := NewMemStore()
	q := NewMediaQuota(store)
	ctx := context.Background()
	fakeNow := time.Unix(1_000_000, 0)
	q.now = func() time.Time { return fakeNow }

	// Seed an existing blob.
	store.PutObject(ctx, "media/alice/seed/blob", []byte("aaaaa"), "application/octet-stream") // 5 bytes

	if ok, _, _ := q.ReserveUpload(ctx, "alice", 10); !ok {
		t.Fatal("first reserve should succeed")
	}
	e, _ := q.entries.Load("alice")
	entry := e.(*quotaEntry)
	if entry.usageBytes != 15 { // 5 seeded + 10 reserved
		t.Fatalf("usageBytes = %d, want 15", entry.usageBytes)
	}

	// Add another 100 bytes of S3 state. Within TTL the cache should not see it.
	store.PutObject(ctx, "media/alice/seed2/blob", make([]byte, 100), "application/octet-stream")
	if ok, _, _ := q.ReserveUpload(ctx, "alice", 10); !ok {
		t.Fatal("second reserve (cached) should succeed")
	}
	if entry.usageBytes != 25 { // 15 + 10 reserved, no re-list
		t.Fatalf("within TTL: usageBytes = %d, want 25 (no re-list)", entry.usageBytes)
	}

	// Advance past TTL; next reserve re-lists, picking up the 100 new bytes.
	fakeNow = fakeNow.Add(QUOTA_CACHE_TTL + time.Second)
	if ok, _, _ := q.ReserveUpload(ctx, "alice", 10); !ok {
		t.Fatal("third reserve (post-TTL) should succeed")
	}
	// S3 truth: 5 + 100 = 105; plus 10 just reserved = 115.
	if entry.usageBytes != 115 {
		t.Fatalf("post-TTL: usageBytes = %d, want 115 (re-list absorbs drift)", entry.usageBytes)
	}
}

// --- Concurrent presign: per-user mutex prevents lost updates ---

func TestMediaQuota_ConcurrentReserveNoLostUpdates(t *testing.T) {
	store := NewMemStore()
	q := NewMediaQuota(store)
	ctx := context.Background()

	const N = 50
	var wg sync.WaitGroup
	var okCount int64
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if ok, _, err := q.ReserveUpload(ctx, "alice", 1000); err == nil && ok {
				atomic.AddInt64(&okCount, 1)
			}
		}()
	}
	wg.Wait()

	if okCount != N {
		t.Fatalf("okCount = %d, want %d", okCount, N)
	}
	e, _ := q.entries.Load("alice")
	entry := e.(*quotaEntry)
	if entry.usageBytes != int64(N)*1000 {
		t.Fatalf("usageBytes = %d, want %d (lost updates)", entry.usageBytes, int64(N)*1000)
	}
	if entry.blobCount != N {
		t.Fatalf("blobCount = %d, want %d", entry.blobCount, N)
	}
}
