package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func testServer(t *testing.T) (*MemStore, http.Handler, Config) {
	t.Helper()
	store := NewMemStore()
	cfg := Config{
		ServerSecret: []byte("test-secret"),
	}
	mux := newMux(store, cfg)
	return store, mux, cfg
}

func TestHealthz(t *testing.T) {
	_, mux, _ := testServer(t)

	req := httptest.NewRequest("GET", "/healthz", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
	}
	if w.Body.String() != "ok" {
		t.Fatalf("body = %q, want %q", w.Body.String(), "ok")
	}
}

func TestRegisterAndResolve(t *testing.T) {
	_, mux, _ := testServer(t)

	// Register
	body := `{"device_label":"laptop","auth_public_key":"dGVzdC1hdXRoLWtleQ","sharing_public_key":"dGVzdC1zaGFyaW5nLWtleQ"}`
	req := httptest.NewRequest("POST", "/v1/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("register status = %d, want %d; body = %s", w.Code, http.StatusOK, w.Body.String())
	}

	var regResp struct {
		UserID       string `json:"user_id"`
		DeviceID     string `json:"device_id"`
		Token        string `json:"token"`
		InviteHandle string `json:"invite_handle"`
	}
	json.NewDecoder(w.Body).Decode(&regResp)

	if regResp.UserID == "" || regResp.DeviceID == "" || regResp.Token == "" || regResp.InviteHandle == "" {
		t.Fatalf("missing fields in register response: %+v", regResp)
	}

	// Invite handle should be two words joined by hyphen
	parts := strings.Split(regResp.InviteHandle, "-")
	if len(parts) != 2 {
		t.Fatalf("invite_handle = %q, want two-word format", regResp.InviteHandle)
	}

	// Resolve
	req = httptest.NewRequest("GET", "/v1/resolve/"+regResp.InviteHandle, nil)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d, want %d; body = %s", w.Code, http.StatusOK, w.Body.String())
	}

	var resolveResp struct {
		UserID           string `json:"user_id"`
		SharingPublicKey string `json:"sharing_public_key"`
	}
	json.NewDecoder(w.Body).Decode(&resolveResp)

	if resolveResp.UserID != regResp.UserID {
		t.Fatalf("resolved user_id = %q, want %q", resolveResp.UserID, regResp.UserID)
	}
	if resolveResp.SharingPublicKey != "dGVzdC1zaGFyaW5nLWtleQ" {
		t.Fatalf("resolved sharing_public_key = %q, want original", resolveResp.SharingPublicKey)
	}
}

func TestResolveNotFound(t *testing.T) {
	_, mux, _ := testServer(t)

	req := httptest.NewRequest("GET", "/v1/resolve/nonexistent-handle", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestSendRequiresAuth(t *testing.T) {
	_, mux, _ := testServer(t)

	req := httptest.NewRequest("POST", "/v1/send", strings.NewReader(`{"envelopes":[]}`))
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestSendWithAuth(t *testing.T) {
	store, mux, _ := testServer(t)

	// Register first to get a valid token and device file
	body := `{"device_label":"laptop","auth_public_key":"dGVzdC1hdXRoLWtleQ","sharing_public_key":"dGVzdC1zaGFyaW5nLWtleQ"}`
	req := httptest.NewRequest("POST", "/v1/register", strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	var regResp struct {
		UserID   string `json:"user_id"`
		DeviceID string `json:"device_id"`
		Token    string `json:"token"`
	}
	json.NewDecoder(w.Body).Decode(&regResp)

	// Send an envelope to self
	envelope := map[string]any{
		"v":            1,
		"to_user":      regResp.UserID,
		"from_user":    regResp.UserID,
		"from_device":  regResp.DeviceID,
		"msg_id":       "msg001",
		"content_type": "megolm.message",
		"payload":      map[string]string{"session_id": "S1", "ciphertext": "dGVzdA"},
	}
	envBytes, _ := json.Marshal(map[string]any{"envelopes": []any{envelope}})

	req = httptest.NewRequest("POST", "/v1/send", strings.NewReader(string(envBytes)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+regResp.Token)
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("send status = %d, want %d; body = %s", w.Code, http.StatusOK, w.Body.String())
	}

	// Verify envelope was written
	key := "inbox/" + regResp.UserID + "/live/msg001"
	data, err := store.GetObject(nil, key)
	if err != nil {
		t.Fatalf("envelope not found at %s", key)
	}
	if len(data) == 0 {
		t.Fatal("envelope is empty")
	}
}

func TestStoreListRequiresAuth(t *testing.T) {
	_, mux, _ := testServer(t)

	req := httptest.NewRequest("GET", "/v1/store/list?prefix=inbox/user1/live/", nil)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}
