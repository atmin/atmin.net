package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// postRegister builds and fires a /v1/register request with the given
// handle. Returns the response recorder for status/body inspection.
func postRegister(t *testing.T, mux http.Handler, handle string) *httptest.ResponseRecorder {
	t.Helper()
	pub, _, _ := ed25519.GenerateKey(nil)
	body, _ := json.Marshal(map[string]string{
		"handle":             handle,
		"device_label":       "test device",
		"auth_public_key":    b64url.EncodeToString(pub),
		"sharing_public_key": b64url.EncodeToString(make([]byte, 65)),
	})
	req := httptest.NewRequest("POST", "/v1/register", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w
}

func TestRegisterHandle_Invalid(t *testing.T) {
	_, mux, _ := testServer(t)
	cases := []struct {
		name   string
		handle string
		want   string // error.code
	}{
		{"too short", "ab", "handle_invalid"},
		{"too long", "abcdefghij1234567890123456789012x", "handle_invalid"},
		{"uppercase", "Alice", "handle_invalid"},
		{"space", "al ice", "handle_invalid"},
		{"underscore", "alice_test", "handle_invalid"},
		{"consecutive hyphens", "alice--bot", "handle_invalid"},
		{"leading hyphen", "-alice", "handle_invalid"},
		{"trailing hyphen", "alice-", "handle_invalid"},
		{"starts with digit", "1alice", "handle_invalid"},
		{"reserved-admin", "admin", "handle_reserved"},
		{"reserved-deleted", "deleted", "handle_reserved"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := postRegister(t, mux, tc.handle)
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400; body = %s", w.Code, w.Body.String())
			}
			var resp struct {
				Error string `json:"error"`
			}
			json.NewDecoder(w.Body).Decode(&resp)
			if resp.Error != tc.want {
				t.Fatalf("error = %q, want %q", resp.Error, tc.want)
			}
		})
	}
}

func TestRegisterHandle_Taken(t *testing.T) {
	_, mux, _ := testServer(t)
	first := postRegister(t, mux, "alice-test")
	if first.Code != http.StatusOK {
		t.Fatalf("first register: status = %d; body = %s", first.Code, first.Body.String())
	}
	second := postRegister(t, mux, "alice-test")
	if second.Code != http.StatusConflict {
		t.Fatalf("second register: status = %d, want 409; body = %s", second.Code, second.Body.String())
	}
	var resp struct {
		Error string `json:"error"`
	}
	json.NewDecoder(second.Body).Decode(&resp)
	if resp.Error != "handle_taken" {
		t.Fatalf("error = %q, want handle_taken", resp.Error)
	}
}

func TestRegisterHandle_InCooldown(t *testing.T) {
	store, mux, _ := testServer(t)

	// Prime a tombstone with released_at in the future-relative-to-now sense
	// (i.e. recent enough that released_at + 30d hasn't elapsed).
	releasedAt := time.Now().UTC().Add(-1 * time.Hour).Format(time.RFC3339)
	tomb := publicHandleData{ReleasedAt: releasedAt}
	data, _ := json.Marshal(tomb)
	store.PutObject(context.Background(), keyHandle("alice-test"), data, "application/json")

	w := postRegister(t, mux, "alice-test")
	if w.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409; body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Error       string `json:"error"`
		ReleasedAt  string `json:"released_at"`
		AvailableAt string `json:"available_at"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Error != "handle_in_cooldown" {
		t.Fatalf("error = %q, want handle_in_cooldown", resp.Error)
	}
	if resp.ReleasedAt != releasedAt {
		t.Fatalf("released_at = %q, want %q", resp.ReleasedAt, releasedAt)
	}
	if resp.AvailableAt == "" {
		t.Fatal("missing available_at in cooldown response")
	}
}

func TestRegisterHandle_StaleTombstoneReclaim(t *testing.T) {
	store, mux, _ := testServer(t)

	// Prime a tombstone whose cooldown has elapsed (released_at + 30d in the past).
	releasedAt := time.Now().UTC().Add(-31 * 24 * time.Hour).Format(time.RFC3339)
	tomb := publicHandleData{ReleasedAt: releasedAt}
	data, _ := json.Marshal(tomb)
	store.PutObject(context.Background(), keyHandle("alice-test"), data, "application/json")

	w := postRegister(t, mux, "alice-test")
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (stale tombstone should be reclaimable); body = %s", w.Code, w.Body.String())
	}

	// The handle projection is now a live one — no released_at.
	handleData, err := store.GetObject(context.Background(), keyHandle("alice-test"))
	if err != nil {
		t.Fatalf("read handle: %v", err)
	}
	var h publicHandleData
	json.Unmarshal(handleData, &h)
	if h.ReleasedAt != "" {
		t.Fatalf("post-reclaim handle still has released_at = %q", h.ReleasedAt)
	}
	if h.UserID == "" {
		t.Fatal("post-reclaim handle missing user_id")
	}
}

func TestRegisterHandle_ConcurrentSameHandle(t *testing.T) {
	_, mux, _ := testServer(t)
	const N = 10
	var wg sync.WaitGroup
	var winners atomic.Int32
	var losers atomic.Int32
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w := postRegister(t, mux, "popular-handle")
			switch w.Code {
			case http.StatusOK:
				winners.Add(1)
			case http.StatusConflict:
				losers.Add(1)
			default:
				t.Errorf("unexpected status %d; body = %s", w.Code, w.Body.String())
			}
		}()
	}
	wg.Wait()
	if got := winners.Load(); got != 1 {
		t.Fatalf("winners = %d, want exactly 1", got)
	}
	if got := losers.Load(); got != N-1 {
		t.Fatalf("losers = %d, want %d", got, N-1)
	}
}

func TestRegisterHandle_ConcurrentDifferentHandles(t *testing.T) {
	_, mux, _ := testServer(t)
	// Each goroutine registers a distinct handle; all should succeed in
	// parallel — regression guard that the mutex is per-handle, not global.
	const N = 8
	var wg sync.WaitGroup
	var ok atomic.Int32
	for i := 0; i < N; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w := postRegister(t, mux, fmt.Sprintf("user-%03d", i))
			if w.Code == http.StatusOK {
				ok.Add(1)
			} else {
				t.Errorf("user-%03d: status %d; body = %s", i, w.Code, w.Body.String())
			}
		}(i)
	}
	wg.Wait()
	if got := ok.Load(); got != N {
		t.Fatalf("ok = %d, want %d", got, N)
	}
}

func TestRegisterHandle_OrphanCleanupOnProfileFailure(t *testing.T) {
	store, mux, _ := testServer(t)

	// Inject a failure on the profile.json write. The handle was already
	// claimed under the mutex; the register handler must best-effort
	// delete the handle projection so the namespace doesn't leak.
	store.putErr = func(key string) error {
		if strings.HasSuffix(key, "/profile.json") {
			return fmt.Errorf("simulated profile-write failure")
		}
		return nil
	}

	w := postRegister(t, mux, "alice-test")
	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500; body = %s", w.Code, w.Body.String())
	}

	// Drop the injection and confirm the handle is free to re-register.
	store.putErr = nil
	retry := postRegister(t, mux, "alice-test")
	if retry.Code != http.StatusOK {
		t.Fatalf("retry status = %d, want 200; body = %s", retry.Code, retry.Body.String())
	}
}
