package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

// helpers shared across middleware tests

func setupAuth(t *testing.T) (*MemStore, Config, *deviceCache, string, string, string) {
	t.Helper()
	store := NewMemStore()
	cfg := Config{ServerSecret: []byte("test-secret")}
	cache := newDeviceCache()
	userID := "01USERAAAAAAAAAAAAAAA0"
	deviceID := "01DEVICEAAAAAAAAAAAAA0"
	token := generateToken(cfg.ServerSecret, userID, deviceID)
	deviceKey := "users/" + userID + "/devices/" + deviceID + ".json"
	store.PutObject(context.Background(), deviceKey, []byte("{}"), "application/json")
	return store, cfg, cache, userID, deviceID, token
}

func TestRequireAuth_HeaderToken(t *testing.T) {
	store, cfg, cache, userID, _, token := setupAuth(t)

	var gotUserID string
	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		gotUserID = userIDFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}, store, cfg, cache)

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if gotUserID != userID {
		t.Fatalf("userID = %q, want %q", gotUserID, userID)
	}
}

func TestRequireAuth_QueryToken(t *testing.T) {
	store, cfg, cache, userID, _, token := setupAuth(t)

	var gotUserID string
	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		gotUserID = userIDFrom(r.Context())
		w.WriteHeader(http.StatusOK)
	}, store, cfg, cache)

	req := httptest.NewRequest("GET", "/test?token="+token, nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if gotUserID != userID {
		t.Fatalf("userID = %q, want %q", gotUserID, userID)
	}
}

func TestRequireAuth_NoToken(t *testing.T) {
	store, cfg, cache, _, _, _ := setupAuth(t)

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, store, cfg, cache)

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
	store, cfg, cache, _, _, _ := setupAuth(t)

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, store, cfg, cache)

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
	cache := newDeviceCache()
	// Token is valid but device file does not exist in store.
	token := generateToken(cfg.ServerSecret, "01USER000", "01DEVICE000")

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, store, cfg, cache)

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

func TestRequireAuth_RevocationInvalidatesCache(t *testing.T) {
	store, cfg, cache, userID, deviceID, token := setupAuth(t)
	deviceKey := "users/" + userID + "/devices/" + deviceID + ".json"

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, store, cfg, cache)

	authReq := func() *http.Request {
		r := httptest.NewRequest("GET", "/test", nil)
		r.Header.Set("Authorization", "Bearer "+token)
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
	store.DeleteObject(context.Background(), deviceKey)
	cache.invalidate(deviceKey)

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
	cache := newDeviceCache()
	token := generateToken(cfg.ServerSecret, "01USER000", "01DEVICE000")

	handler := requireAuth(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}, store, cfg, cache)

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
