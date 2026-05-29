package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// helpers shared across middleware tests

type authSetup struct {
	store     *MemStore
	cfg       Config
	devCache  *deviceCache
	profCache *profileCache
	userID    string
	deviceID  string
	token     string
}

func setupAuth(t *testing.T) authSetup {
	t.Helper()
	store := NewMemStore()
	cfg := Config{ServerSecret: []byte("test-secret")}
	userID := "01USERAAAAAAAAAAAAAAA0"
	deviceID := "01DEVICEAAAAAAAAAAAAA0"
	token := generateToken(cfg.ServerSecret, userID, deviceID, 1)
	// Device + profile present; the middleware now reads both. KeyVersion=0
	// rides implicit kv=1, which matches the token we just minted.
	store.PutObject(context.Background(), keyDevice(userID, deviceID), []byte("{}"), "application/json")
	putProfile(context.Background(), store, &Profile{UserID: userID})
	return authSetup{
		store:     store,
		cfg:       cfg,
		devCache:  newDeviceCache(),
		profCache: newProfileCache(),
		userID:    userID,
		deviceID:  deviceID,
		token:     token,
	}
}

func TestRequireAuth_HeaderToken(t *testing.T) {
	s := setupAuth(t)

	var gotUserID string
	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		gotUserID = userIDFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}, s.store, s.cfg, s.devCache, s.profCache, true)

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+s.token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if gotUserID != s.userID {
		t.Fatalf("userID = %q, want %q", gotUserID, s.userID)
	}
}

func TestRequireAuth_QueryToken(t *testing.T) {
	s := setupAuth(t)

	var gotUserID string
	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		gotUserID = userIDFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}, s.store, s.cfg, s.devCache, s.profCache, true)

	req := httptest.NewRequest("GET", "/test?token="+s.token, nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if gotUserID != s.userID {
		t.Fatalf("userID = %q, want %q", gotUserID, s.userID)
	}
}

func TestRequireAuth_NoToken(t *testing.T) {
	s := setupAuth(t)

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, s.store, s.cfg, s.devCache, s.profCache, true)

	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	var errResp struct {
		Error string `json:"error"`
	}
	json.NewDecoder(w.Body).Decode(&errResp)
	if errResp.Error != "unauthorized" {
		t.Fatalf("error = %q, want %q", errResp.Error, "unauthorized")
	}
}

func TestRequireAuth_MalformedToken(t *testing.T) {
	s := setupAuth(t)

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, s.store, s.cfg, s.devCache, s.profCache, true)

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer not-a-valid-token")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", w.Code)
	}
	var errResp struct {
		Error string `json:"error"`
	}
	json.NewDecoder(w.Body).Decode(&errResp)
	if errResp.Error != "unauthorized" {
		t.Fatalf("error = %q, want %q", errResp.Error, "unauthorized")
	}
}

func TestRequireAuth_DeviceRevoked(t *testing.T) {
	store := NewMemStore()
	cfg := Config{ServerSecret: []byte("test-secret")}
	// Token is valid but device file does not exist in store. Device-existence
	// is checked before the profile lookup, so this trips before the kv check.
	token := generateToken(cfg.ServerSecret, "01USER000", "01DEVICE000", 1)

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, store, cfg, newDeviceCache(), newProfileCache(), true)

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
	var errResp struct {
		Error string `json:"error"`
	}
	json.NewDecoder(w.Body).Decode(&errResp)
	if errResp.Error != "device_revoked" {
		t.Fatalf("error = %q, want %q", errResp.Error, "device_revoked")
	}
}

func TestRequireAuth_KeyVersionStale(t *testing.T) {
	s := setupAuth(t)
	// Another device rotated the credential: the profile is now at kv=2
	// while the token we hold is still bound to kv=1.
	putProfile(context.Background(), s.store, &Profile{UserID: s.userID, KeyVersion: 2})

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, s.store, s.cfg, s.devCache, s.profCache, true)

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+s.token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401; body = %s", w.Code, w.Body.String())
	}
	var errResp struct {
		Error   string `json:"error"`
		Current int    `json:"current"`
	}
	json.NewDecoder(w.Body).Decode(&errResp)
	if errResp.Error != "key_version_stale" {
		t.Fatalf("error = %q, want key_version_stale", errResp.Error)
	}
	// Body carries the current version so the client can re-derive at it.
	if errResp.Current != 2 {
		t.Fatalf("current = %d, want 2", errResp.Current)
	}
}

func TestRequireAuth_KeyVersionNotEnforced(t *testing.T) {
	s := setupAuth(t)
	// Profile rotated ahead of the token, but this route opts out of the
	// kv check (as rotate-keys does): the stale token must still pass so an
	// idempotent retry can reach the handler and replay its recorded outcome.
	putProfile(context.Background(), s.store, &Profile{UserID: s.userID, KeyVersion: 2})

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, s.store, s.cfg, s.devCache, s.profCache, false)

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+s.token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (kv check opted out); body = %s", w.Code, w.Body.String())
	}
}

func TestRequireAuth_RevocationInvalidatesCache(t *testing.T) {
	s := setupAuth(t)
	deviceKey := keyDevice(s.userID, s.deviceID)

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, s.store, s.cfg, s.devCache, s.profCache, true)

	authReq := func() *http.Request {
		r := httptest.NewRequest("GET", "/test", nil)
		r.Header.Set("Authorization", "Bearer "+s.token)
		return r
	}

	// First request: device file exists → 200, cache entry written
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, authReq())
	if w.Code != http.StatusOK {
		t.Fatalf("first request: status = %d", w.Code)
	}

	// Simulate revocation: delete device file and evict cache entry.
	// Without the invalidate call the cached entry would allow the request
	// through for up to the 30 s TTL — this confirms the contract.
	s.store.DeleteObject(context.Background(), deviceKey)
	s.devCache.invalidate(deviceKey)

	// Second request: cache miss → HeadObject → ErrNotFound → 403 immediately
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, authReq())
	if w.Code != http.StatusForbidden {
		t.Fatalf("after revocation: status = %d, want 403", w.Code)
	}
	var errResp struct {
		Error string `json:"error"`
	}
	json.NewDecoder(w.Body).Decode(&errResp)
	if errResp.Error != "device_revoked" {
		t.Fatalf("error = %q, want %q", errResp.Error, "device_revoked")
	}
}

func TestRequireAuth_HeadStoreError(t *testing.T) {
	store := NewMemStore()
	store.headErr = errors.New("connection refused")
	cfg := Config{ServerSecret: []byte("test-secret")}
	token := generateToken(cfg.ServerSecret, "01USER000", "01DEVICE000", 1)

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, store, cfg, newDeviceCache(), newProfileCache(), true)

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", w.Code)
	}
	var errResp struct {
		Error string `json:"error"`
	}
	json.NewDecoder(w.Body).Decode(&errResp)
	if errResp.Error != "internal" {
		t.Fatalf("error = %q, want %q", errResp.Error, "internal")
	}
}

func TestRemoteIP_XFFParsing(t *testing.T) {
	tests := []struct {
		name       string
		remoteAddr string
		xff        string
		wantIP     string
	}{
		{"bare RemoteAddr", "1.2.3.4:5678", "", "1.2.3.4"},
		{"single XFF", "10.0.0.1:1234", "1.2.3.4", "1.2.3.4"},
		{"multi XFF", "10.0.0.1:1234", "1.2.3.4, 5.6.7.8", "1.2.3.4"},
		{"multi XFF with spaces", "10.0.0.1:1234", "   1.2.3.4   ,5.6.7.8", "1.2.3.4"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", "/", nil)
			req.RemoteAddr = tc.remoteAddr
			if tc.xff != "" {
				req.Header.Set("X-Forwarded-For", tc.xff)
			}
			got := remoteIP(req)
			if got != tc.wantIP {
				t.Fatalf("remoteIP = %q, want %q", got, tc.wantIP)
			}
		})
	}
}

func TestLogRequests_StatusAndUserID(t *testing.T) {
	const uid = "01USERAAAAAAAAAAAAAAA0"

	inner := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})

	var buf bytes.Buffer
	logger := slog.New(slog.NewTextHandler(&buf, nil))
	old := slog.Default()
	slog.SetDefault(logger)
	defer slog.SetDefault(old)

	req := httptest.NewRequest("GET", "/test", nil)
	req.RemoteAddr = "1.2.3.4:5678"
	req = req.WithContext(context.WithValue(req.Context(), ctxUserID, uid))

	w := httptest.NewRecorder()
	logRequests(inner).ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}

	line := buf.String()
	for _, want := range []string{"status=200", "dur_ms=", "user_id=" + uid} {
		if !strings.Contains(line, want) {
			t.Errorf("log line missing %q; got: %s", want, line)
		}
	}
}
