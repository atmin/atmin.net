package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/gowebpki/jcs"
	"github.com/oklog/ulid/v2"
)

func testServer(t *testing.T) (*MemStore, http.Handler, Config) {
	t.Helper()
	store := NewMemStore()
	cfg := Config{
		ServerSecret: []byte("test-secret"),
	}
	hub := NewEventHub()
	mux := newMux(store, cfg, hub)
	return store, mux, cfg
}

// testUser registers a user with a real Ed25519 keypair and returns everything
// needed to make authenticated requests and sign auth proofs.
type testUserInfo struct {
	UserID   string
	DeviceID string
	Token    string
	Handle   string
	AuthPub  ed25519.PublicKey
	AuthPriv ed25519.PrivateKey
}

// testHandleCounter generates unique, regex-valid handles for the
// test fixtures. The client picks the handle now (ADR-0013), so every
// register call needs one distinct enough to avoid cross-test collisions.
var testHandleCounter atomic.Int64

func nextTestHandle() string {
	n := testHandleCounter.Add(1)
	return fmt.Sprintf("test-user-%06d", n)
}

func registerTestUser(t *testing.T, mux http.Handler, label string) testUserInfo {
	t.Helper()
	return registerTestUserWithHandle(t, mux, label, nextTestHandle())
}

func registerTestUserWithHandle(t *testing.T, mux http.Handler, label, handle string) testUserInfo {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	pubB64 := b64url.EncodeToString(pub)

	// Every account is password-derived: registration always carries salt + kdf.
	body, _ := json.Marshal(map[string]any{
		"handle":             handle,
		"device_label":       label,
		"auth_public_key":    pubB64,
		"sharing_public_key": b64url.EncodeToString([]byte("sharing-key-placeholder-32bytes!")),
		"salt":               b64url.EncodeToString(make([]byte, 16)),
		"kdf":                map[string]any{"type": "argon2id", "m": 65536, "t": 3, "p": 1},
	})
	req := httptest.NewRequest("POST", "/v1/register", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("register %s (%s): status = %d; body = %s", label, handle, w.Code, w.Body.String())
	}

	var resp struct {
		UserID   string `json:"user_id"`
		DeviceID string `json:"device_id"`
		Token    string `json:"token"`
		Handle   string `json:"handle"`
	}
	json.NewDecoder(w.Body).Decode(&resp)

	return testUserInfo{
		UserID:   resp.UserID,
		DeviceID: resp.DeviceID,
		Token:    resp.Token,
		Handle:   resp.Handle,
		AuthPub:  pub,
		AuthPriv: priv,
	}
}

// signAuthProof builds an auth proof for an account at key_version 1 — the
// shape registerTestUser accounts use until they rotate. For a rotated
// account, use signAuthProofKV with the current key_version.
func signAuthProof(priv ed25519.PrivateKey, userID, deviceID string) string {
	return signAuthProofKV(priv, userID, deviceID, 1)
}

// signAuthProofKV builds the single canonical auth-proof shape: a payload
// carrying key_version, signed over its JCS-canonicalized bytes.
func signAuthProofKV(priv ed25519.PrivateKey, userID, deviceID string, kv int) string {
	payload := map[string]any{
		"user_id":     userID,
		"device_id":   deviceID,
		"timestamp":   time.Now().UTC().Format(time.RFC3339),
		"key_version": kv,
	}
	raw, _ := json.Marshal(payload)
	canonical, _ := jcs.Transform(raw)
	sig := ed25519.Sign(priv, canonical)

	proofBytes, _ := json.Marshal(map[string]any{
		"payload":   payload,
		"signature": b64url.EncodeToString(sig),
	})
	return string(proofBytes)
}

func authedRequest(t *testing.T, method, url, token string, body string) *http.Request {
	t.Helper()
	req := httptest.NewRequest(method, url, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return req
}

// --- Tests ---

func TestHealthz(t *testing.T) {
	_, mux, _ := testServer(t)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/healthz", nil))

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusOK)
	}
	if w.Body.String() != "ok" {
		t.Fatalf("body = %q, want %q", w.Body.String(), "ok")
	}
}

func TestRegisterAndResolve(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUserWithHandle(t, mux, "Alice's laptop", "alice-laptop")

	// The handle the client requested is what comes back in the response
	// and what's projected into S3.
	if alice.Handle != "alice-laptop" {
		t.Fatalf("handle = %q, want %q", alice.Handle, "alice-laptop")
	}

	// Verify profile.json contains handle
	profileData, err := store.GetObject(context.Background(), "users/"+alice.UserID+"/profile.json")
	if err != nil {
		t.Fatalf("reading profile: %v", err)
	}
	var profile map[string]string
	json.Unmarshal(profileData, &profile)
	if profile["handle"] != alice.Handle {
		t.Fatalf("profile handle = %q, want %q", profile["handle"], alice.Handle)
	}

	// Verify handle file contains sharing_public_key
	handleData, err := store.GetObject(context.Background(), "handles/"+alice.Handle+".json")
	if err != nil {
		t.Fatalf("reading handle: %v", err)
	}
	var handleObj map[string]string
	json.Unmarshal(handleData, &handleObj)
	if handleObj["sharing_public_key"] == "" {
		t.Fatal("handle sharing_public_key is empty")
	}

	// Resolve
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/v1/resolve/"+alice.Handle, nil))

	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d; body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		UserID           string `json:"user_id"`
		SharingPublicKey string `json:"sharing_public_key"`
	}
	json.NewDecoder(w.Body).Decode(&resp)

	if resp.UserID != alice.UserID {
		t.Fatalf("resolved user_id = %q, want %q", resp.UserID, alice.UserID)
	}
	if resp.SharingPublicKey == "" {
		t.Fatal("resolved sharing_public_key is empty")
	}
}

func TestResolveNotFound(t *testing.T) {
	_, mux, _ := testServer(t)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/v1/resolve/nonexistent-handle", nil))

	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusNotFound)
	}
}

func TestUpdateProfile(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	body, _ := json.Marshal(map[string]any{
		"display_name": "Alice Wonderland",
		"avatar_url":   "media/" + alice.UserID + "/avatar/photo.jpg",
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "PUT", "/v1/profile", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("update profile status = %d; body = %s", w.Code, w.Body.String())
	}

	// Verify profile.json
	profileData, _ := store.GetObject(context.Background(), "users/"+alice.UserID+"/profile.json")
	var profile map[string]string
	json.Unmarshal(profileData, &profile)
	if profile["display_name"] != "Alice Wonderland" {
		t.Fatalf("profile display_name = %q, want %q", profile["display_name"], "Alice Wonderland")
	}
	if profile["avatar_url"] != "media/"+alice.UserID+"/avatar/photo.jpg" {
		t.Fatalf("profile avatar_url = %q", profile["avatar_url"])
	}

	// Verify handle file was updated
	handleData, _ := store.GetObject(context.Background(), "handles/"+alice.Handle+".json")
	var handleObj map[string]string
	json.Unmarshal(handleData, &handleObj)
	if handleObj["display_name"] != "Alice Wonderland" {
		t.Fatalf("handle display_name = %q, want %q", handleObj["display_name"], "Alice Wonderland")
	}
}

func TestUpdateProfilePartial(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Set display_name only
	body, _ := json.Marshal(map[string]any{"display_name": "Alice"})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "PUT", "/v1/profile", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}

	// avatar_url should not be set
	profileData, _ := store.GetObject(context.Background(), "users/"+alice.UserID+"/profile.json")
	var profile map[string]string
	json.Unmarshal(profileData, &profile)
	if profile["display_name"] != "Alice" {
		t.Fatalf("display_name = %q", profile["display_name"])
	}
	if _, ok := profile["avatar_url"]; ok {
		t.Fatalf("avatar_url should not be set, got %q", profile["avatar_url"])
	}
}

func TestResolveWithDisplayName(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Update profile with display_name
	body, _ := json.Marshal(map[string]any{"display_name": "Alice W"})
	mux.ServeHTTP(httptest.NewRecorder(), authedRequest(t, "PUT", "/v1/profile", alice.Token, string(body)))

	// Resolve should include display_name
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/v1/resolve/"+alice.Handle, nil))
	if w.Code != http.StatusOK {
		t.Fatalf("resolve status = %d", w.Code)
	}

	var resp map[string]string
	json.NewDecoder(w.Body).Decode(&resp)
	if resp["display_name"] != "Alice W" {
		t.Fatalf("resolved display_name = %q, want %q", resp["display_name"], "Alice W")
	}
	if resp["sharing_public_key"] == "" {
		t.Fatal("resolved sharing_public_key is empty")
	}
}

func TestUpdateProfileInvalidJSON(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "PUT", "/v1/profile", alice.Token, "not json"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestDeleteProfile(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Send a message so inbox has data
	envBody, _ := json.Marshal(map[string]any{
		"envelopes": []map[string]string{{"recipient_id": alice.UserID, "payload": "dGVzdA=="}},
	})
	mux.ServeHTTP(httptest.NewRecorder(), authedRequest(t, "POST", "/v1/send", alice.Token, string(envBody)))

	// Delete profile
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "DELETE", "/v1/profile", alice.Token, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("delete profile status = %d; body = %s", w.Code, w.Body.String())
	}

	// Profile should be gone
	_, err := store.GetObject(context.Background(), "users/"+alice.UserID+"/profile.json")
	if err == nil {
		t.Fatal("profile still exists after delete")
	}

	// Handle remains as a tombstone (ADR-0013): same key, body has only
	// released_at, all other fields stripped.
	handleData, err := store.GetObject(context.Background(), "handles/"+alice.Handle+".json")
	if err != nil {
		t.Fatalf("handle should remain as tombstone after delete: %v", err)
	}
	var tomb publicHandleData
	if err := json.Unmarshal(handleData, &tomb); err != nil {
		t.Fatalf("tombstone parse: %v", err)
	}
	if tomb.ReleasedAt == "" {
		t.Fatal("tombstone missing released_at")
	}
	if tomb.UserID != "" || tomb.SharingPublicKey != "" {
		t.Fatalf("tombstone should strip user_id/sharing_public_key, got %+v", tomb)
	}

	// Inbox should be gone
	keys, _, _ := store.ListObjects(context.Background(), "inbox/"+alice.UserID+"/", 10, "")
	if len(keys) > 0 {
		t.Fatalf("inbox still has %d objects after delete", len(keys))
	}

	// Resolve returns 410 Gone with released_at + available_at while the
	// cooldown window is open.
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/v1/resolve/"+alice.Handle, nil))
	if w.Code != http.StatusGone {
		t.Fatalf("resolve after delete: status = %d, want 410", w.Code)
	}
	var resp struct {
		Error       string `json:"error"`
		ReleasedAt  string `json:"released_at"`
		AvailableAt string `json:"available_at"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Error != "released" {
		t.Fatalf("resolve error = %q, want released", resp.Error)
	}
	if resp.ReleasedAt == "" || resp.AvailableAt == "" {
		t.Fatalf("missing cooldown timestamps: %+v", resp)
	}
}

func TestDeleteProfileAlreadyDeleted(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// First delete
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "DELETE", "/v1/profile", alice.Token, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("first delete status = %d", w.Code)
	}

	// Second delete should 404
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "DELETE", "/v1/profile", alice.Token, ""))
	if w.Code != http.StatusNotFound {
		t.Fatalf("second delete status = %d, want 404", w.Code)
	}
}

func TestAddDevice(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice's laptop")

	newDeviceID := "01NEW_DEVICE_ID_12345"
	proof := signAuthProof(alice.AuthPriv, alice.UserID, newDeviceID)

	body, _ := json.Marshal(map[string]any{
		"user_id":      alice.UserID,
		"auth_proof":   json.RawMessage(proof),
		"device_label": "Alice's phone",
	})

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/devices", alice.Token, string(body)))

	if w.Code != http.StatusOK {
		t.Fatalf("add device status = %d; body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		DeviceID string `json:"device_id"`
		Token    string `json:"token"`
	}
	json.NewDecoder(w.Body).Decode(&resp)

	if resp.DeviceID != newDeviceID {
		t.Fatalf("device_id = %q, want %q", resp.DeviceID, newDeviceID)
	}
	if resp.Token == "" {
		t.Fatal("token is empty")
	}
	if resp.Token == alice.Token {
		t.Fatal("new device token should differ from original")
	}
}

func TestAddDeviceWrongKey(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "laptop")

	// Sign with a different key
	_, wrongPriv, _ := ed25519.GenerateKey(nil)
	proof := signAuthProof(wrongPriv, alice.UserID, "rogue-device")

	body, _ := json.Marshal(map[string]any{
		"user_id":      alice.UserID,
		"auth_proof":   json.RawMessage(proof),
		"device_label": "rogue",
	})

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/devices", alice.Token, string(body)))

	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusForbidden)
	}
}

func TestRevokeDevice(t *testing.T) {
	store, mux, cfg := testServer(t)
	alice := registerTestUser(t, mux, "laptop")

	// Add a second device
	phoneDeviceID := "01PHONE_DEVICE_ID_123"
	proof := signAuthProof(alice.AuthPriv, alice.UserID, phoneDeviceID)
	body, _ := json.Marshal(map[string]any{
		"user_id":      alice.UserID,
		"auth_proof":   json.RawMessage(proof),
		"device_label": "phone",
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/devices", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("add device: status = %d", w.Code)
	}
	var addResp struct {
		Token string `json:"token"`
	}
	json.NewDecoder(w.Body).Decode(&addResp)
	phoneToken := addResp.Token

	// Verify phone can make requests
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/list?prefix=inbox/"+alice.UserID+"/live/", phoneToken, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("phone store/list before revoke: status = %d", w.Code)
	}

	// Revoke phone from laptop
	revokeProof := signAuthProof(alice.AuthPriv, alice.UserID, phoneDeviceID)
	revokeBody, _ := json.Marshal(map[string]any{
		"device_id":  phoneDeviceID,
		"auth_proof": json.RawMessage(revokeProof),
	})
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/devices/revoke", alice.Token, string(revokeBody)))
	if w.Code != http.StatusOK {
		t.Fatalf("revoke: status = %d; body = %s", w.Code, w.Body.String())
	}

	// Verify device file is gone
	deviceKey := "users/" + alice.UserID + "/devices/" + phoneDeviceID + ".json"
	if err := store.HeadObject(nil, deviceKey); err == nil {
		t.Fatal("device file should be deleted after revocation")
	}

	// Verify phone gets 403 device_revoked (need fresh mux to clear cache)
	freshMux := newMux(store, cfg, NewEventHub())
	w = httptest.NewRecorder()
	freshMux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/list?prefix=inbox/"+alice.UserID+"/live/", phoneToken, ""))
	if w.Code != http.StatusForbidden {
		t.Fatalf("revoked device: status = %d, want 403", w.Code)
	}

	var errResp struct {
		Error string `json:"error"`
	}
	json.NewDecoder(w.Body).Decode(&errResp)
	if errResp.Error != "device_revoked" {
		t.Fatalf("error = %q, want %q", errResp.Error, "device_revoked")
	}

	// Verify laptop still works
	w = httptest.NewRecorder()
	freshMux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/list?prefix=inbox/"+alice.UserID+"/live/", alice.Token, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("laptop after revoke: status = %d", w.Code)
	}
}

func TestSendRequiresAuth(t *testing.T) {
	_, mux, _ := testServer(t)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/v1/send", strings.NewReader(`{"envelopes":[]}`)))

	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestSendAndReceive(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	bob := registerTestUser(t, mux, "Bob")

	// Alice sends to Bob + self-copy
	envelopes := []map[string]any{
		{
			"v": 1, "to_user": bob.UserID,
			"from_user": alice.UserID, "from_device": alice.DeviceID,
			"msg_id": "msg001", "content_type": "megolm.message",
			"payload": map[string]string{"session_id": "S1", "ciphertext": "dGVzdA"},
		},
		{
			"v": 1, "to_user": alice.UserID,
			"from_user": alice.UserID, "from_device": alice.DeviceID,
			"msg_id": "msg001", "content_type": "megolm.message",
			"payload": map[string]string{"session_id": "S1", "ciphertext": "dGVzdA"},
		},
	}
	body, _ := json.Marshal(map[string]any{"envelopes": envelopes})

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/send", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("send status = %d; body = %s", w.Code, w.Body.String())
	}

	// Verify both inboxes have the message
	if _, err := store.GetObject(nil, "inbox/"+bob.UserID+"/live/msg001"); err != nil {
		t.Fatal("message not in Bob's inbox")
	}
	if _, err := store.GetObject(nil, "inbox/"+alice.UserID+"/live/msg001"); err != nil {
		t.Fatal("self-copy not in Alice's inbox")
	}
}

func TestSendMismatchedIdentity(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	bob := registerTestUser(t, mux, "Bob")

	// Alice tries to send with Bob's user_id as from_user
	envelope := map[string]any{
		"v": 1, "to_user": bob.UserID,
		"from_user": bob.UserID, "from_device": alice.DeviceID,
		"msg_id": "msg001", "content_type": "megolm.message",
		"payload": map[string]string{"session_id": "S1", "ciphertext": "dGVzdA"},
	}
	body, _ := json.Marshal(map[string]any{"envelopes": []any{envelope}})

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/send", alice.Token, string(body)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for mismatched from_user", w.Code)
	}
}

func TestStoreListOwn(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Send a message to self to populate inbox
	envelope := map[string]any{
		"v": 1, "to_user": alice.UserID,
		"from_user": alice.UserID, "from_device": alice.DeviceID,
		"msg_id": "msg001", "content_type": "megolm.message",
		"payload": map[string]string{"session_id": "S1", "ciphertext": "dGVzdA"},
	}
	body, _ := json.Marshal(map[string]any{"envelopes": []any{envelope}})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/send", alice.Token, string(body)))

	// List own inbox
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/list?prefix=inbox/"+alice.UserID+"/live/", alice.Token, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("list status = %d; body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		Keys []string `json:"keys"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if len(resp.Keys) != 1 {
		t.Fatalf("keys = %v, want 1 entry", resp.Keys)
	}
}

func TestStoreListOtherUserForbidden(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	bob := registerTestUser(t, mux, "Bob")

	// Alice tries to list Bob's inbox
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/list?prefix=inbox/"+bob.UserID+"/live/", alice.Token, ""))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for other user's prefix", w.Code)
	}
}

func TestStoreGetObject(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Plant an object in Alice's key backup
	key := "keys/" + alice.UserID + "/live/S1"
	store.PutObject(nil, key, []byte(`{"iv":"aaa","ciphertext":"bbb"}`), "application/json")

	// Alice fetches it
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/object?key="+key, alice.Token, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("get object status = %d; body = %s", w.Code, w.Body.String())
	}
	if !strings.Contains(w.Body.String(), "ciphertext") {
		t.Fatalf("unexpected body: %s", w.Body.String())
	}
}

func TestStoreGetObjectNotFound(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/object?key=keys/"+alice.UserID+"/live/NOPE", alice.Token, ""))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestStoreGetObjectOtherUserForbidden(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	bob := registerTestUser(t, mux, "Bob")

	key := "keys/" + bob.UserID + "/live/S1"
	store.PutObject(nil, key, []byte("secret"), "application/json")

	// Alice tries to read Bob's key
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/object?key="+key, alice.Token, ""))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestStorePresign(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	body, _ := json.Marshal(map[string]any{
		"key":   "media/" + alice.UserID + "/abc123/photo.jpg",
		"bytes": 48000,
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/presign", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("presign status = %d; body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		PresignedURL string `json:"presigned_url"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.PresignedURL == "" {
		t.Fatal("presigned_url is empty")
	}
}

func TestStorePresignOtherUserForbidden(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	bob := registerTestUser(t, mux, "Bob")

	body, _ := json.Marshal(map[string]any{
		"key":   "media/" + bob.UserID + "/abc123/photo.jpg",
		"bytes": 48000,
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/presign", alice.Token, string(body)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

func TestStorePresignOwnUserPrefix(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	body, _ := json.Marshal(map[string]any{
		"key":   "users/" + alice.UserID + "/contacts.json",
		"bytes": 1024,
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/presign", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("presign own users/ status = %d; body = %s", w.Code, w.Body.String())
	}
}

func TestStorePresignOtherUserProfileForbidden(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	bob := registerTestUser(t, mux, "Bob")

	body, _ := json.Marshal(map[string]any{
		"key":   "users/" + bob.UserID + "/profile.json",
		"bytes": 512,
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/presign", alice.Token, string(body)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("presign other users/ status = %d, want 403", w.Code)
	}
}

func TestStoreListRequiresAuth(t *testing.T) {
	_, mux, _ := testServer(t)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/v1/store/list?prefix=inbox/user1/live/", nil))
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("status = %d, want %d", w.Code, http.StatusUnauthorized)
	}
}

func TestStoreReadUserProfile(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	bob := registerTestUser(t, mux, "Bob")

	// Alice can read Bob's profile (needed for key fetch)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/object?key=users/"+bob.UserID+"/profile.json", alice.Token, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("reading other user's profile: status = %d, want 200", w.Code)
	}
}

// --- Compaction tests ---

// sendTestMessages sends n messages to the user's own inbox and returns msg_ids in order.
func sendTestMessages(t *testing.T, mux http.Handler, user testUserInfo, n int) []string {
	t.Helper()
	ids := make([]string, n)
	for i := range n {
		msgID := ulid.Make().String()
		ids[i] = msgID
		envelope := map[string]any{
			"v": 1, "to_user": user.UserID,
			"from_user": user.UserID, "from_device": user.DeviceID,
			"msg_id": msgID, "content_type": "megolm.message",
			"payload": map[string]string{"session_id": "S1", "ciphertext": "dGVzdA"},
		}
		body, _ := json.Marshal(map[string]any{"envelopes": []any{envelope}})
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/send", user.Token, string(body)))
		if w.Code != http.StatusOK {
			t.Fatalf("send message %d: status = %d; body = %s", i, w.Code, w.Body.String())
		}
	}
	return ids
}

func TestCompactBasic(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Send 3 messages
	ids := sendTestMessages(t, mux, alice, 3)
	prefix := "inbox/" + alice.UserID + "/live/"

	// Compact all 3 (up_to = last msg_id)
	body, _ := json.Marshal(map[string]any{
		"prefix": prefix,
		"up_to":  ids[2],
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("compact status = %d; body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		Archived   int    `json:"archived"`
		ArchiveKey string `json:"archive_key"`
	}
	json.NewDecoder(w.Body).Decode(&resp)

	if resp.Archived != 3 {
		t.Fatalf("archived = %d, want 3", resp.Archived)
	}
	if resp.ArchiveKey == "" {
		t.Fatal("archive_key is empty")
	}

	// Originals should be deleted
	for _, id := range ids {
		if _, err := store.GetObject(nil, prefix+id); err == nil {
			t.Fatalf("original %s should have been deleted", id)
		}
	}

	// Archive should exist and be valid CBOR
	archiveData, err := store.GetObject(nil, resp.ArchiveKey)
	if err != nil {
		t.Fatalf("archive not found: %v", err)
	}

	var decoded []map[string]any
	if err := cbor.Unmarshal(archiveData, &decoded); err != nil {
		t.Fatalf("CBOR decode failed: %v", err)
	}
	if len(decoded) != 3 {
		t.Fatalf("decoded %d objects, want 3", len(decoded))
	}

	// Verify round-trip: msg_ids match
	for i, obj := range decoded {
		if obj["msg_id"] != ids[i] {
			t.Fatalf("decoded[%d].msg_id = %v, want %s", i, obj["msg_id"], ids[i])
		}
	}
}

func TestCompactPartial(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Send 5 messages
	ids := sendTestMessages(t, mux, alice, 5)
	prefix := "inbox/" + alice.UserID + "/live/"

	// Compact only the first 3 (up_to = ids[2])
	body, _ := json.Marshal(map[string]any{
		"prefix": prefix,
		"up_to":  ids[2],
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("compact status = %d; body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		Archived int `json:"archived"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Archived != 3 {
		t.Fatalf("archived = %d, want 3", resp.Archived)
	}

	// First 3 deleted
	for _, id := range ids[:3] {
		if _, err := store.GetObject(nil, prefix+id); err == nil {
			t.Fatalf("original %s should have been deleted", id)
		}
	}

	// Last 2 still present
	for _, id := range ids[3:] {
		if _, err := store.GetObject(nil, prefix+id); err != nil {
			t.Fatalf("message %s should still exist", id)
		}
	}
}

func TestCompactEmpty(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Compact an empty prefix
	body, _ := json.Marshal(map[string]any{
		"prefix": "inbox/" + alice.UserID + "/live/",
		"up_to":  "ZZZZZZZZ",
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("compact empty status = %d; body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		Archived int `json:"archived"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Archived != 0 {
		t.Fatalf("archived = %d, want 0 for empty prefix", resp.Archived)
	}
}

func TestCompactOtherUserForbidden(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	bob := registerTestUser(t, mux, "Bob")

	body, _ := json.Marshal(map[string]any{
		"prefix": "inbox/" + bob.UserID + "/live/",
		"up_to":  "ZZZZZZZZ",
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403 for other user's prefix", w.Code)
	}
}

func TestCompactIdempotent(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	ids := sendTestMessages(t, mux, alice, 2)
	prefix := "inbox/" + alice.UserID + "/live/"
	compactBody, _ := json.Marshal(map[string]any{
		"prefix": prefix,
		"up_to":  ids[1],
	})

	// First compaction
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(compactBody)))
	if w.Code != http.StatusOK {
		t.Fatalf("first compact: status = %d", w.Code)
	}

	var resp1 struct {
		Archived   int    `json:"archived"`
		ArchiveKey string `json:"archive_key"`
	}
	json.NewDecoder(w.Body).Decode(&resp1)
	archive1, _ := store.GetObject(nil, resp1.ArchiveKey)

	// Second compaction of same prefix — originals already deleted, so archived=0
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(compactBody)))
	if w.Code != http.StatusOK {
		t.Fatalf("second compact: status = %d", w.Code)
	}

	var resp2 struct {
		Archived int `json:"archived"`
	}
	json.NewDecoder(w.Body).Decode(&resp2)
	if resp2.Archived != 0 {
		t.Fatalf("second compact archived = %d, want 0 (originals already gone)", resp2.Archived)
	}

	// Original archive still intact
	archive1After, err := store.GetObject(nil, resp1.ArchiveKey)
	if err != nil {
		t.Fatalf("archive disappeared after second compact: %v", err)
	}
	if string(archive1) != string(archive1After) {
		t.Fatal("archive was modified by second compaction")
	}
}

func TestCompactSameDayMerge(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	prefix := "inbox/" + alice.UserID + "/live/"

	// First batch: send 3 messages and compact.
	ids1 := sendTestMessages(t, mux, alice, 3)
	body, _ := json.Marshal(map[string]any{"prefix": prefix, "up_to": ids1[2]})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("first compact: status = %d; body = %s", w.Code, w.Body.String())
	}
	var resp1 struct {
		Archived   int    `json:"archived"`
		ArchiveKey string `json:"archive_key"`
	}
	json.NewDecoder(w.Body).Decode(&resp1)
	if resp1.Archived != 3 {
		t.Fatalf("first compact: archived = %d, want 3", resp1.Archived)
	}

	// Second batch: send 3 more messages and compact.
	ids2 := sendTestMessages(t, mux, alice, 3)
	body, _ = json.Marshal(map[string]any{"prefix": prefix, "up_to": ids2[2]})
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("second compact: status = %d; body = %s", w.Code, w.Body.String())
	}
	var resp2 struct {
		Archived   int    `json:"archived"`
		ArchiveKey string `json:"archive_key"`
	}
	json.NewDecoder(w.Body).Decode(&resp2)
	if resp2.Archived != 3 {
		t.Fatalf("second compact: archived = %d, want 3", resp2.Archived)
	}

	// Old archive should be deleted.
	if _, err := store.GetObject(nil, resp1.ArchiveKey); err == nil {
		t.Fatal("old archive should have been deleted after merge")
	}

	// New archive should contain all 6 messages (merged).
	archiveData, err := store.GetObject(nil, resp2.ArchiveKey)
	if err != nil {
		t.Fatalf("merged archive not found: %v", err)
	}
	var decoded []map[string]any
	if err := cbor.Unmarshal(archiveData, &decoded); err != nil {
		t.Fatalf("CBOR decode failed: %v", err)
	}
	if len(decoded) != 6 {
		t.Fatalf("merged archive has %d objects, want 6", len(decoded))
	}

	// Verify order: first batch then second batch.
	allIDs := append(ids1, ids2...)
	for i, obj := range decoded {
		if obj["msg_id"] != allIDs[i] {
			t.Fatalf("decoded[%d].msg_id = %v, want %s", i, obj["msg_id"], allIDs[i])
		}
	}
}

func TestCompactSameDayDedup(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	prefix := "inbox/" + alice.UserID + "/live/"

	// Send 3 messages and compact.
	ids := sendTestMessages(t, mux, alice, 3)
	body, _ := json.Marshal(map[string]any{"prefix": prefix, "up_to": ids[2]})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("compact status = %d", w.Code)
	}

	// Simulate crash-before-delete: re-insert msg2 and msg3 as live objects.
	for _, id := range ids[1:] {
		envelope := map[string]any{
			"v": 1, "to_user": alice.UserID,
			"from_user": alice.UserID, "from_device": alice.DeviceID,
			"msg_id": id, "content_type": "megolm.message",
			"payload": map[string]string{"session_id": "S1", "ciphertext": "dGVzdA"},
		}
		data, _ := json.Marshal(envelope)
		if err := store.PutObject(context.Background(), prefix+id, data, "application/json"); err != nil {
			t.Fatalf("re-insert %s: %v", id, err)
		}
	}

	// Compact again — should merge and deduplicate.
	body, _ = json.Marshal(map[string]any{"prefix": prefix, "up_to": ids[2]})
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("second compact status = %d", w.Code)
	}
	var resp struct {
		Archived   int    `json:"archived"`
		ArchiveKey string `json:"archive_key"`
	}
	json.NewDecoder(w.Body).Decode(&resp)

	// archived count reflects new live objects (the 2 re-inserted), not total.
	if resp.Archived != 2 {
		t.Fatalf("archived = %d, want 2", resp.Archived)
	}

	// Archive should have exactly 3 unique messages (no duplicates).
	archiveData, err := store.GetObject(nil, resp.ArchiveKey)
	if err != nil {
		t.Fatalf("archive not found: %v", err)
	}
	var decoded []map[string]any
	if err := cbor.Unmarshal(archiveData, &decoded); err != nil {
		t.Fatalf("CBOR decode failed: %v", err)
	}
	if len(decoded) != 3 {
		t.Fatalf("deduped archive has %d objects, want 3", len(decoded))
	}

	// Verify msg_ids match original order.
	for i, obj := range decoded {
		if obj["msg_id"] != ids[i] {
			t.Fatalf("decoded[%d].msg_id = %v, want %s", i, obj["msg_id"], ids[i])
		}
	}
}

func TestCompactKeepsNoMsgIDObjects(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	prefix := "keys/" + alice.UserID + "/live/"

	// Plant two key-backup objects (no msg_id) and one envelope (with msg_id).
	// ULIDs are monotonically increasing so kb1Key < kb2Key < envKey.
	kb1Key := ulid.Make().String()
	kb2Key := ulid.Make().String()
	envKey := ulid.Make().String()

	kb1Data, _ := json.Marshal(map[string]any{"iv": "aaaaaa", "ciphertext": "bbbbbb"})
	kb2Data, _ := json.Marshal(map[string]any{"iv": "cccccc", "ciphertext": "dddddd"})
	envData, _ := json.Marshal(map[string]any{"msg_id": "MSG001", "v": 1, "content_type": "megolm.message"})

	store.PutObject(context.Background(), prefix+kb1Key, kb1Data, "application/json")
	store.PutObject(context.Background(), prefix+kb2Key, kb2Data, "application/json")
	store.PutObject(context.Background(), prefix+envKey, envData, "application/json")

	body, _ := json.Marshal(map[string]any{"prefix": prefix, "up_to": envKey})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("compact status = %d; body = %s", w.Code, w.Body.String())
	}

	var resp struct {
		Archived   int    `json:"archived"`
		ArchiveKey string `json:"archive_key"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Archived != 3 {
		t.Fatalf("archived = %d, want 3", resp.Archived)
	}

	archiveData, err := store.GetObject(context.Background(), resp.ArchiveKey)
	if err != nil {
		t.Fatalf("archive not found: %v", err)
	}
	var decoded []map[string]any
	if err := cbor.Unmarshal(archiveData, &decoded); err != nil {
		t.Fatalf("CBOR decode failed: %v", err)
	}
	if len(decoded) != 3 {
		t.Fatalf("archive has %d objects, want 3 (2 key backups + 1 envelope)", len(decoded))
	}

	var withMsgID, withoutMsgID int
	for _, obj := range decoded {
		if _, ok := obj["msg_id"]; ok {
			withMsgID++
		} else {
			withoutMsgID++
		}
	}
	if withMsgID != 1 {
		t.Fatalf("objects with msg_id = %d, want 1", withMsgID)
	}
	if withoutMsgID != 2 {
		t.Fatalf("objects without msg_id = %d, want 2", withoutMsgID)
	}
}

func TestCompactMultipleStaleArchives(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	prefix := "inbox/" + alice.UserID + "/live/"

	// Simulate two stale archives from double-crash (manually write CBOR).
	// Archives live at sibling prefix: inbox/{uid}/archive/ (not under live/).
	today := time.Now().UTC().Format("2006-01-02")
	archivePrefix := strings.TrimSuffix(prefix, "live/") + "archive/"
	staleKey1 := archivePrefix + today + "-" + ulid.Make().String()
	staleKey2 := archivePrefix + today + "-" + ulid.Make().String()

	archive1Objs := []map[string]any{
		{"msg_id": "stale01", "v": 1, "content_type": "megolm.message"},
		{"msg_id": "stale02", "v": 1, "content_type": "megolm.message"},
	}
	archive2Objs := []map[string]any{
		{"msg_id": "stale02", "v": 1, "content_type": "megolm.message"}, // duplicate
		{"msg_id": "stale03", "v": 1, "content_type": "megolm.message"},
	}
	data1, _ := cbor.Marshal(archive1Objs)
	data2, _ := cbor.Marshal(archive2Objs)
	store.PutObject(context.Background(), staleKey1, data1, "application/cbor")
	store.PutObject(context.Background(), staleKey2, data2, "application/cbor")

	// Send a new message and compact.
	ids := sendTestMessages(t, mux, alice, 1)
	body, _ := json.Marshal(map[string]any{"prefix": prefix, "up_to": ids[0]})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("compact status = %d; body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Archived   int    `json:"archived"`
		ArchiveKey string `json:"archive_key"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Archived != 1 {
		t.Fatalf("archived = %d, want 1", resp.Archived)
	}

	// Both stale archives should be deleted.
	if _, err := store.GetObject(nil, staleKey1); err == nil {
		t.Fatal("stale archive 1 should have been deleted")
	}
	if _, err := store.GetObject(nil, staleKey2); err == nil {
		t.Fatal("stale archive 2 should have been deleted")
	}

	// New archive should have 4 unique objects: stale01, stale02, stale03, + new msg.
	archiveData, err := store.GetObject(nil, resp.ArchiveKey)
	if err != nil {
		t.Fatalf("merged archive not found: %v", err)
	}
	var decoded []map[string]any
	if err := cbor.Unmarshal(archiveData, &decoded); err != nil {
		t.Fatalf("CBOR decode failed: %v", err)
	}
	if len(decoded) != 4 {
		t.Fatalf("merged archive has %d objects, want 4", len(decoded))
	}

	// Verify order: stale objects first (deduped), then new message last.
	wantIDs := []string{"stale01", "stale02", "stale03", ids[0]}
	for i, obj := range decoded {
		if obj["msg_id"] != wantIDs[i] {
			t.Fatalf("decoded[%d].msg_id = %v, want %s", i, obj["msg_id"], wantIDs[i])
		}
	}
}

// --- Register error paths ---

func TestRegisterInvalidJSON(t *testing.T) {
	_, mux, _ := testServer(t)
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("POST", "/v1/register", strings.NewReader("not json")))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestRegisterMissingFields(t *testing.T) {
	_, mux, _ := testServer(t)

	tests := []struct {
		name string
		body map[string]string
	}{
		{"missing handle", map[string]string{"device_label": "phone", "auth_public_key": "abc", "sharing_public_key": "def"}},
		{"missing device_label", map[string]string{"handle": nextTestHandle(), "auth_public_key": "abc", "sharing_public_key": "def"}},
		{"missing auth_public_key", map[string]string{"handle": nextTestHandle(), "device_label": "phone", "sharing_public_key": "def"}},
		{"missing sharing_public_key", map[string]string{"handle": nextTestHandle(), "device_label": "phone", "auth_public_key": "abc"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(tc.body)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, httptest.NewRequest("POST", "/v1/register", strings.NewReader(string(body))))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", w.Code)
			}
		})
	}
}

// --- AddDevice error paths ---

func TestAddDeviceInvalidJSON(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/devices", alice.Token, "not json"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestAddDeviceUserNotFound(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	proof := signAuthProof(alice.AuthPriv, "nonexistent-user", "device1")
	body, _ := json.Marshal(map[string]any{
		"user_id":      "nonexistent-user",
		"auth_proof":   json.RawMessage(proof),
		"device_label": "phone",
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/devices", alice.Token, string(body)))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

// --- RevokeDevice error paths ---

func TestRevokeDeviceInvalidJSON(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/devices/revoke", alice.Token, "not json"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestRevokeDeviceWrongKey(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	_, wrongPriv, _ := ed25519.GenerateKey(nil)
	proof := signAuthProof(wrongPriv, alice.UserID, alice.DeviceID)
	body, _ := json.Marshal(map[string]any{
		"device_id":  alice.DeviceID,
		"auth_proof": json.RawMessage(proof),
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/devices/revoke", alice.Token, string(body)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

// --- Send error paths ---

func TestSendInvalidJSON(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/send", alice.Token, "not json"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestSendBadEnvelopeJSON(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Envelopes array contains a non-JSON-object string
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/send", alice.Token,
		`{"envelopes":["not a valid envelope"]}`))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestSendMismatchedDevice(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	// Correct from_user but wrong from_device
	envelope := map[string]any{
		"v": 1, "to_user": alice.UserID,
		"from_user": alice.UserID, "from_device": "wrong-device",
		"msg_id": "msg001", "content_type": "megolm.message",
		"payload": map[string]string{"session_id": "S1", "ciphertext": "dGVzdA"},
	}
	body, _ := json.Marshal(map[string]any{"envelopes": []any{envelope}})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/send", alice.Token, string(body)))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

// --- StoreList error paths ---

func TestStoreListMissingPrefix(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET", "/v1/store/list", alice.Token, ""))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestStoreListDisallowedPrefix(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/list?prefix=handles/", alice.Token, ""))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

// --- StoreObject error paths ---

func TestStoreObjectMissingKey(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET", "/v1/store/object", alice.Token, ""))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestStoreObjectDisallowedKey(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/object?key=handles/something.json", alice.Token, ""))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403", w.Code)
	}
}

// --- StorePresign error paths ---

func TestStorePresignInvalidJSON(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/presign", alice.Token, "not json"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestStorePresignMissingFields(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	tests := []struct {
		name string
		body map[string]any
	}{
		{"missing key", map[string]any{"bytes": 1000}},
		{"missing bytes", map[string]any{"key": "media/" + alice.UserID + "/photo.jpg"}},
		{"zero bytes", map[string]any{"key": "media/" + alice.UserID + "/photo.jpg", "bytes": 0}},
		{"negative bytes", map[string]any{"key": "media/" + alice.UserID + "/photo.jpg", "bytes": -1}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(tc.body)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/presign", alice.Token, string(body)))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", w.Code)
			}
		})
	}
}

// --- DeleteDevice tests ---

func TestDeleteDevice_Self(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "DELETE", "/v1/devices", alice.Token, ""))
	if w.Code != http.StatusOK {
		t.Fatalf("delete device status = %d; body = %s", w.Code, w.Body.String())
	}

	// Device file must be gone
	deviceKey := "users/" + alice.UserID + "/devices/" + alice.DeviceID + ".json"
	if err := store.HeadObject(context.Background(), deviceKey); err == nil {
		t.Fatal("device file should be gone after DELETE /v1/devices")
	}

	// Same token, same mux: cache was invalidated inside handler, so next request hits
	// HeadObject which returns ErrNotFound → 403 device_revoked.
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "GET",
		"/v1/store/list?prefix=inbox/"+alice.UserID+"/live/", alice.Token, ""))
	if w.Code != http.StatusForbidden {
		t.Fatalf("after self-delete: status = %d, want 403", w.Code)
	}
	var errResp struct {
		Error string `json:"error"`
	}
	json.NewDecoder(w.Body).Decode(&errResp)
	if errResp.Error != "device_revoked" {
		t.Fatalf("error = %q, want %q", errResp.Error, "device_revoked")
	}
}

// --- Send idempotency ---

func TestSendIdempotent_SameMsgID(t *testing.T) {
	store := NewMemStore()
	cfg := Config{ServerSecret: []byte("test-secret")}
	hub := NewEventHub()
	mux := newMux(store, cfg, hub)

	alice := registerTestUser(t, mux, "Alice")

	// Register a buffered listener so Notify calls are counted without blocking.
	notifyCh := make(chan string, 10)
	hub.Register(alice.UserID, notifyCh)
	defer hub.Unregister(alice.UserID, notifyCh)

	msgID := "IDEMPOTENT_MSG_01"
	envelope := map[string]any{
		"v": 1, "to_user": alice.UserID,
		"from_user": alice.UserID, "from_device": alice.DeviceID,
		"msg_id": msgID, "content_type": "megolm.message",
		"payload": map[string]string{"session_id": "S1", "ciphertext": "dGVzdA"},
	}
	body, _ := json.Marshal(map[string]any{"envelopes": []any{envelope}})

	// First send
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/send", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("first send: status = %d; body = %s", w.Code, w.Body.String())
	}

	// Second send with identical msg_id — overwrite is allowed by spec
	w = httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/send", alice.Token, string(body)))
	if w.Code != http.StatusOK {
		t.Fatalf("second send: status = %d; body = %s", w.Code, w.Body.String())
	}

	// Exactly one inbox key must exist (same key overwritten, not duplicated)
	keys, _, _ := store.ListObjects(context.Background(), "inbox/"+alice.UserID+"/live/", 100, "")
	if len(keys) != 1 {
		t.Fatalf("inbox has %d objects, want exactly 1", len(keys))
	}
	wantKey := "inbox/" + alice.UserID + "/live/" + msgID
	if keys[0] != wantKey {
		t.Fatalf("inbox key = %q, want %q", keys[0], wantKey)
	}

	// Notify must have fired twice — spec does not promise dedup of notifications
	if got := len(notifyCh); got != 2 {
		t.Fatalf("notify count = %d, want 2", got)
	}
}

// --- StoreCompact error paths ---

func TestCompactInvalidJSON(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, "not json"))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestCompactMissingFields(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")

	tests := []struct {
		name string
		body map[string]string
	}{
		{"missing prefix", map[string]string{"up_to": "ZZZ"}},
		{"missing up_to", map[string]string{"prefix": "inbox/" + alice.UserID + "/live/"}},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			body, _ := json.Marshal(tc.body)
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, authedRequest(t, "POST", "/v1/store/compact", alice.Token, string(body)))
			if w.Code != http.StatusBadRequest {
				t.Fatalf("status = %d, want 400", w.Code)
			}
		})
	}
}
