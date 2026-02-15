package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/fxamacker/cbor/v2"
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
	UserID       string
	DeviceID     string
	Token        string
	InviteHandle string
	AuthPub      ed25519.PublicKey
	AuthPriv     ed25519.PrivateKey
}

func registerTestUser(t *testing.T, mux http.Handler, label string) testUserInfo {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	pubB64 := b64url.EncodeToString(pub)

	body, _ := json.Marshal(map[string]string{
		"device_label":       label,
		"auth_public_key":    pubB64,
		"sharing_public_key": b64url.EncodeToString([]byte("sharing-key-placeholder-32bytes!")),
	})
	req := httptest.NewRequest("POST", "/v1/register", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("register %s: status = %d; body = %s", label, w.Code, w.Body.String())
	}

	var resp struct {
		UserID       string `json:"user_id"`
		DeviceID     string `json:"device_id"`
		Token        string `json:"token"`
		InviteHandle string `json:"invite_handle"`
	}
	json.NewDecoder(w.Body).Decode(&resp)

	return testUserInfo{
		UserID:       resp.UserID,
		DeviceID:     resp.DeviceID,
		Token:        resp.Token,
		InviteHandle: resp.InviteHandle,
		AuthPub:      pub,
		AuthPriv:     priv,
	}
}

func signAuthProof(priv ed25519.PrivateKey, userID, deviceID string) string {
	payload := AuthProofPayload{
		UserID:    userID,
		DeviceID:  deviceID,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	payloadBytes, _ := json.Marshal(payload)
	sig := ed25519.Sign(priv, payloadBytes)

	proof := AuthProof{
		Payload:   payload,
		Signature: b64url.EncodeToString(sig),
	}
	proofBytes, _ := json.Marshal(proof)
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
	alice := registerTestUser(t, mux, "Alice's laptop")

	// Invite handle should be two words
	parts := strings.Split(alice.InviteHandle, "-")
	if len(parts) != 2 {
		t.Fatalf("invite_handle = %q, want two-word format", alice.InviteHandle)
	}

	// Verify profile.json contains invite_handle
	profileData, err := store.GetObject(context.Background(), "users/"+alice.UserID+"/profile.json")
	if err != nil {
		t.Fatalf("reading profile: %v", err)
	}
	var profile map[string]string
	json.Unmarshal(profileData, &profile)
	if profile["invite_handle"] != alice.InviteHandle {
		t.Fatalf("profile invite_handle = %q, want %q", profile["invite_handle"], alice.InviteHandle)
	}

	// Verify invite file contains sharing_public_key
	inviteData, err := store.GetObject(context.Background(), "invites/"+alice.InviteHandle+".json")
	if err != nil {
		t.Fatalf("reading invite: %v", err)
	}
	var invite map[string]string
	json.Unmarshal(inviteData, &invite)
	if invite["sharing_public_key"] == "" {
		t.Fatal("invite sharing_public_key is empty")
	}

	// Resolve
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, httptest.NewRequest("GET", "/v1/resolve/"+alice.InviteHandle, nil))

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

	// Plant an object in Alice's backup
	key := "backups/" + alice.UserID + "/keys/live/S1"
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
		"/v1/store/object?key=backups/"+alice.UserID+"/keys/live/NOPE", alice.Token, ""))
	if w.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", w.Code)
	}
}

func TestStoreGetObjectOtherUserForbidden(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUser(t, mux, "Alice")
	bob := registerTestUser(t, mux, "Bob")

	key := "backups/" + bob.UserID + "/keys/live/S1"
	store.PutObject(nil, key, []byte("secret"), "application/json")

	// Alice tries to read Bob's backup
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
		{"missing device_label", map[string]string{"auth_public_key": "abc", "sharing_public_key": "def"}},
		{"missing auth_public_key", map[string]string{"device_label": "phone", "sharing_public_key": "def"}},
		{"missing sharing_public_key", map[string]string{"device_label": "phone", "auth_public_key": "abc"}},
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
		"/v1/store/list?prefix=invites/", alice.Token, ""))
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
		"/v1/store/object?key=invites/something.json", alice.Token, ""))
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
