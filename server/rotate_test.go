package main

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/gowebpki/jcs"
)

// ── Test helpers ─────────────────────────────────────────────────────

// registerTestUserV2 registers a v2 (salt/kdf-bearing) account and returns
// the keypair so rotation tests can produce the continuity signature.
func registerTestUserV2(t *testing.T, mux http.Handler, label string) testUserInfo {
	t.Helper()
	pub, priv, _ := ed25519.GenerateKey(nil)
	pubB64 := b64url.EncodeToString(pub)

	body, _ := json.Marshal(map[string]any{
		"handle":             nextTestHandle(),
		"device_label":       label,
		"auth_public_key":    pubB64,
		"sharing_public_key": b64url.EncodeToString(make([]byte, 65)),
		"salt":               b64url.EncodeToString(make([]byte, 16)),
		"kdf":                map[string]any{"type": "argon2id", "m": 65536, "t": 3, "p": 1},
	})
	req := httptest.NewRequest("POST", "/v1/register", strings.NewReader(string(body)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("register %s: status = %d; body = %s", label, w.Code, w.Body.String())
	}
	var resp struct {
		UserID, DeviceID, Token, Handle string
	}
	if err := json.Unmarshal(w.Body.Bytes(), &struct {
		UserID   *string `json:"user_id"`
		DeviceID *string `json:"device_id"`
		Token    *string `json:"token"`
		Handle   *string `json:"handle"`
	}{&resp.UserID, &resp.DeviceID, &resp.Token, &resp.Handle}); err != nil {
		t.Fatalf("decode register response: %v", err)
	}

	return testUserInfo{
		UserID: resp.UserID, DeviceID: resp.DeviceID, Token: resp.Token,
		Handle: resp.Handle, AuthPub: pub, AuthPriv: priv,
	}
}

func freshUUID(t *testing.T) string {
	t.Helper()
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		t.Fatalf("rand.Read: %v", err)
	}
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		binary.BigEndian.Uint32(b[0:4]),
		binary.BigEndian.Uint16(b[4:6]),
		binary.BigEndian.Uint16(b[6:8]),
		binary.BigEndian.Uint16(b[8:10]),
		b[10:16],
	)
}

type rotationParams struct {
	requestID    string
	newKV        int
	newAuthPub   []byte
	newSharePub  []byte // 65 bytes
	newSalt      []byte // 16 bytes
	tamperedBody bool   // sign over a different body than we send
}

// buildRotateKeys produces a wire-format request body whose
// continuity_signature is valid under oldPriv for the JCS-canonical form of
// everything except continuity_signature.
func buildRotateKeys(t *testing.T, oldPriv ed25519.PrivateKey, p rotationParams) []byte {
	t.Helper()
	if p.newSharePub == nil {
		p.newSharePub = make([]byte, 65)
	}
	if p.newSalt == nil {
		p.newSalt = make([]byte, 16)
	}
	body := map[string]any{
		"request_id":         p.requestID,
		"key_version":        p.newKV,
		"auth_public_key":    b64url.EncodeToString(p.newAuthPub),
		"sharing_public_key": b64url.EncodeToString(p.newSharePub),
		"salt":               b64url.EncodeToString(p.newSalt),
		"kdf":                map[string]any{"type": "argon2id", "m": 65536, "t": 3, "p": 1},
	}
	raw, _ := json.Marshal(body)
	canonical, err := jcs.Transform(raw)
	if err != nil {
		t.Fatalf("jcs.Transform: %v", err)
	}
	if p.tamperedBody {
		// Sign over a permuted version so signature ≠ body.
		canonical = append(canonical, []byte("X")...)
	}
	sig := ed25519.Sign(oldPriv, canonical)
	body["continuity_signature"] = b64url.EncodeToString(sig)
	out, _ := json.Marshal(body)
	return out
}

func rotateRequest(t *testing.T, token string, body []byte) *http.Request {
	t.Helper()
	r := httptest.NewRequest("POST", "/v1/rotate-keys", bytes.NewReader(body))
	r.Header.Set("Content-Type", "application/json")
	r.Header.Set("Authorization", "Bearer "+token)
	return r
}

// ── Tests ────────────────────────────────────────────────────────────

func TestRotateKeys_GoldenPath(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")

	newPub, _, _ := ed25519.GenerateKey(nil)
	body := buildRotateKeys(t, alice.AuthPriv, rotationParams{
		requestID: freshUUID(t), newKV: 2, newAuthPub: newPub,
	})

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, rotateRequest(t, alice.Token, body))
	if w.Code != http.StatusOK {
		t.Fatalf("rotate status = %d; body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Token      string `json:"token"`
		KeyVersion int    `json:"key_version"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.KeyVersion != 2 {
		t.Fatalf("response key_version = %d, want 2", resp.KeyVersion)
	}

	// profile.json reflects new keys + kv = 2
	pdata, _ := store.GetObject(context.Background(), keyProfile(alice.UserID))
	var prof Profile
	json.Unmarshal(pdata, &prof)
	if prof.AuthPublicKey != b64url.EncodeToString(newPub) {
		t.Fatalf("profile auth key not rotated")
	}
	if prof.KeyVersion != 2 {
		t.Fatalf("profile key_version = %d, want 2", prof.KeyVersion)
	}

	// handles/{handle}.json projection also reflects new fields.
	hdata, _ := store.GetObject(context.Background(), keyHandle(alice.Handle))
	var proj publicHandleData
	json.Unmarshal(hdata, &proj)
	if proj.KeyVersion != 2 {
		t.Fatalf("handle projection key_version = %d, want 2", proj.KeyVersion)
	}

	// resolve surfaces the new salt/kdf/key_version
	rw := httptest.NewRecorder()
	mux.ServeHTTP(rw, httptest.NewRequest("GET", "/v1/resolve/"+alice.Handle, nil))
	var resolved struct {
		KeyVersion int `json:"key_version"`
	}
	json.NewDecoder(rw.Body).Decode(&resolved)
	if resolved.KeyVersion != 2 {
		t.Fatalf("resolved key_version = %d, want 2", resolved.KeyVersion)
	}

	// Old token (kv=1) is now stale.
	oldReq := httptest.NewRequest("DELETE", "/v1/devices", nil)
	oldReq.Header.Set("Authorization", "Bearer "+alice.Token)
	staleW := httptest.NewRecorder()
	mux.ServeHTTP(staleW, oldReq)
	if staleW.Code != http.StatusUnauthorized {
		t.Fatalf("stale-token request status = %d, want 401", staleW.Code)
	}
	var staleErr struct {
		Error   string `json:"error"`
		Current int    `json:"current"`
	}
	json.NewDecoder(staleW.Body).Decode(&staleErr)
	if staleErr.Error != "key_version_stale" {
		t.Fatalf("stale error = %q, want key_version_stale", staleErr.Error)
	}
	if staleErr.Current != 2 {
		t.Fatalf("stale current = %d, want 2", staleErr.Current)
	}
}

func TestRotateKeys_BadContinuitySignature(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")
	newPub, _, _ := ed25519.GenerateKey(nil)

	body := buildRotateKeys(t, alice.AuthPriv, rotationParams{
		requestID: freshUUID(t), newKV: 2, newAuthPub: newPub, tamperedBody: true,
	})

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, rotateRequest(t, alice.Token, body))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Error string `json:"error"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Error != "bad_continuity" {
		t.Fatalf("error = %q, want bad_continuity", resp.Error)
	}
}

// The continuity signature must verify against the *current* (pre-rotation)
// auth_public_key. A signature by the new key — even one that perfectly
// matches `req.auth_public_key` — must be rejected, otherwise an attacker
// who can forge a rotation request needs only to know any keypair, not
// the account's old credential.
func TestRotateKeys_ContinuitySignatureFromNewKeyRejected(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")

	newPub, newPriv, _ := ed25519.GenerateKey(nil)
	// Body is well-formed and the signature is over the exact JCS-canonical
	// form of it — but signed with newPriv instead of alice.AuthPriv.
	body := buildRotateKeys(t, newPriv, rotationParams{
		requestID: freshUUID(t), newKV: 2, newAuthPub: newPub,
	})

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, rotateRequest(t, alice.Token, body))
	if w.Code != http.StatusForbidden {
		t.Fatalf("status = %d, want 403; body = %s", w.Code, w.Body.String())
	}
	var resp struct {
		Error string `json:"error"`
	}
	json.NewDecoder(w.Body).Decode(&resp)
	if resp.Error != "bad_continuity" {
		t.Fatalf("error = %q, want bad_continuity", resp.Error)
	}
}

func TestRotateKeys_KeyVersionMismatch(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")
	newPub, _, _ := ed25519.GenerateKey(nil)

	for _, kv := range []int{1, 3} {
		t.Run(fmt.Sprintf("kv=%d", kv), func(t *testing.T) {
			body := buildRotateKeys(t, alice.AuthPriv, rotationParams{
				requestID: freshUUID(t), newKV: kv, newAuthPub: newPub,
			})
			w := httptest.NewRecorder()
			mux.ServeHTTP(w, rotateRequest(t, alice.Token, body))
			if w.Code != http.StatusConflict {
				t.Fatalf("status = %d, want 409; body = %s", w.Code, w.Body.String())
			}
			var resp struct {
				Error   string `json:"error"`
				Current int    `json:"current"`
			}
			json.NewDecoder(w.Body).Decode(&resp)
			if resp.Error != "key_version_stale" || resp.Current != 1 {
				t.Fatalf("got %+v, want key_version_stale current=1", resp)
			}
		})
	}
}

func TestRotateKeys_IdempotentReplay_Success(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")
	newPub, _, _ := ed25519.GenerateKey(nil)
	reqID := freshUUID(t)
	body := buildRotateKeys(t, alice.AuthPriv, rotationParams{
		requestID: reqID, newKV: 2, newAuthPub: newPub,
	})

	w1 := httptest.NewRecorder()
	mux.ServeHTTP(w1, rotateRequest(t, alice.Token, body))
	if w1.Code != http.StatusOK {
		t.Fatalf("first rotate status = %d", w1.Code)
	}
	firstBody := w1.Body.String()

	// Replay: same request_id, same body bytes. Must return the SAME
	// response and NOT bump key_version further (would be 3 if rerun).
	w2 := httptest.NewRecorder()
	mux.ServeHTTP(w2, rotateRequest(t, alice.Token, body))
	if w2.Code != http.StatusOK {
		t.Fatalf("replay status = %d", w2.Code)
	}
	if w2.Body.String() != firstBody {
		t.Fatalf("replay body diverged:\n got: %s\nwant: %s", w2.Body.String(), firstBody)
	}

	pdata, _ := store.GetObject(context.Background(), keyProfile(alice.UserID))
	var prof Profile
	json.Unmarshal(pdata, &prof)
	if prof.KeyVersion != 2 {
		t.Fatalf("profile kv = %d after replay, want 2 (no rerun)", prof.KeyVersion)
	}
}

func TestRotateKeys_IdempotentReplay_Failure(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")
	newPub, _, _ := ed25519.GenerateKey(nil)
	reqID := freshUUID(t)

	body := buildRotateKeys(t, alice.AuthPriv, rotationParams{
		requestID: reqID, newKV: 5, newAuthPub: newPub, // wrong kv
	})
	w1 := httptest.NewRecorder()
	mux.ServeHTTP(w1, rotateRequest(t, alice.Token, body))
	if w1.Code != http.StatusConflict {
		t.Fatalf("first status = %d, want 409", w1.Code)
	}
	firstBody := w1.Body.String()

	w2 := httptest.NewRecorder()
	mux.ServeHTTP(w2, rotateRequest(t, alice.Token, body))
	if w2.Code != http.StatusConflict {
		t.Fatalf("replay status = %d, want 409", w2.Code)
	}
	if w2.Body.String() != firstBody {
		t.Fatalf("replay 409 body diverged:\n got: %s\nwant: %s", w2.Body.String(), firstBody)
	}
}

func TestRotateKeys_ConcurrentSameUser_OnlyOneWins(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")
	newPubA, _, _ := ed25519.GenerateKey(nil)
	newPubB, _, _ := ed25519.GenerateKey(nil)

	bodyA := buildRotateKeys(t, alice.AuthPriv, rotationParams{
		requestID: freshUUID(t), newKV: 2, newAuthPub: newPubA,
	})
	bodyB := buildRotateKeys(t, alice.AuthPriv, rotationParams{
		requestID: freshUUID(t), newKV: 2, newAuthPub: newPubB,
	})

	wA, wB := httptest.NewRecorder(), httptest.NewRecorder()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); mux.ServeHTTP(wA, rotateRequest(t, alice.Token, bodyA)) }()
	go func() { defer wg.Done(); mux.ServeHTTP(wB, rotateRequest(t, alice.Token, bodyB)) }()
	wg.Wait()

	codes := []int{wA.Code, wB.Code}
	var winners, losers int
	for _, c := range codes {
		switch c {
		case http.StatusOK:
			winners++
		case http.StatusConflict:
			losers++
		default:
			t.Fatalf("unexpected status %d (both: %v)", c, codes)
		}
	}
	if winners != 1 || losers != 1 {
		t.Fatalf("winners=%d losers=%d, want exactly 1 of each; codes=%v", winners, losers, codes)
	}

	// Profile must be at kv=2 (one rotation), not 3.
	pdata, _ := store.GetObject(context.Background(), keyProfile(alice.UserID))
	var prof Profile
	json.Unmarshal(pdata, &prof)
	if prof.KeyVersion != 2 {
		t.Fatalf("profile kv = %d, want 2", prof.KeyVersion)
	}
}

func TestRotateKeys_ConcurrentDifferentUsers_BothWin(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")
	bob := registerTestUserV2(t, mux, "Bob")
	newPubA, _, _ := ed25519.GenerateKey(nil)
	newPubB, _, _ := ed25519.GenerateKey(nil)

	bodyA := buildRotateKeys(t, alice.AuthPriv, rotationParams{
		requestID: freshUUID(t), newKV: 2, newAuthPub: newPubA,
	})
	bodyB := buildRotateKeys(t, bob.AuthPriv, rotationParams{
		requestID: freshUUID(t), newKV: 2, newAuthPub: newPubB,
	})

	wA, wB := httptest.NewRecorder(), httptest.NewRecorder()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); mux.ServeHTTP(wA, rotateRequest(t, alice.Token, bodyA)) }()
	go func() { defer wg.Done(); mux.ServeHTTP(wB, rotateRequest(t, bob.Token, bodyB)) }()
	wg.Wait()
	if wA.Code != http.StatusOK || wB.Code != http.StatusOK {
		t.Fatalf("alice=%d bob=%d, want both 200", wA.Code, wB.Code)
	}
}

func TestRotateKeys_ConcurrentSameRequestID(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")
	newPub, _, _ := ed25519.GenerateKey(nil)
	body := buildRotateKeys(t, alice.AuthPriv, rotationParams{
		requestID: freshUUID(t), newKV: 2, newAuthPub: newPub,
	})

	wA, wB := httptest.NewRecorder(), httptest.NewRecorder()
	var wg sync.WaitGroup
	wg.Add(2)
	go func() { defer wg.Done(); mux.ServeHTTP(wA, rotateRequest(t, alice.Token, body)) }()
	go func() { defer wg.Done(); mux.ServeHTTP(wB, rotateRequest(t, alice.Token, body)) }()
	wg.Wait()

	if wA.Code != http.StatusOK || wB.Code != http.StatusOK {
		t.Fatalf("alice=%d alice'=%d, want both 200", wA.Code, wB.Code)
	}
	if wA.Body.String() != wB.Body.String() {
		t.Fatalf("concurrent same-request_id bodies diverged:\n  %s\n  %s",
			wA.Body.String(), wB.Body.String())
	}

	// One actual rotation: profile.kv = 2 (not 3 from double-write).
	pdata, _ := store.GetObject(context.Background(), keyProfile(alice.UserID))
	var prof Profile
	json.Unmarshal(pdata, &prof)
	if prof.KeyVersion != 2 {
		t.Fatalf("profile kv = %d, want 2", prof.KeyVersion)
	}
}

func TestRotateKeys_RejectsMalformedRequestID(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")
	newPub, _, _ := ed25519.GenerateKey(nil)
	body := buildRotateKeys(t, alice.AuthPriv, rotationParams{
		requestID: "not-a-uuid", newKV: 2, newAuthPub: newPub,
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, rotateRequest(t, alice.Token, body))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestRotateKeys_RejectsMalformedKDF(t *testing.T) {
	_, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")
	newPub, _, _ := ed25519.GenerateKey(nil)

	// Build a body with an invalid KDF (m=0) — sig is valid over this body
	// but the handler must reject before continuity verification.
	bad := map[string]any{
		"request_id":         freshUUID(t),
		"key_version":        2,
		"auth_public_key":    b64url.EncodeToString(newPub),
		"sharing_public_key": b64url.EncodeToString(make([]byte, 65)),
		"salt":               b64url.EncodeToString(make([]byte, 16)),
		"kdf":                map[string]any{"type": "argon2id", "m": 0, "t": 3, "p": 1},
	}
	raw, _ := json.Marshal(bad)
	canonical, _ := jcs.Transform(raw)
	bad["continuity_signature"] = b64url.EncodeToString(ed25519.Sign(alice.AuthPriv, canonical))
	out, _ := json.Marshal(bad)

	w := httptest.NewRecorder()
	mux.ServeHTTP(w, rotateRequest(t, alice.Token, out))
	if w.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", w.Code)
	}
}

func TestRotateKeys_OnlyAffectsCallersAccount(t *testing.T) {
	store, mux, _ := testServer(t)
	alice := registerTestUserV2(t, mux, "Alice")
	bob := registerTestUserV2(t, mux, "Bob")

	// Alice rotates her own account.
	newPub, _, _ := ed25519.GenerateKey(nil)
	body := buildRotateKeys(t, alice.AuthPriv, rotationParams{
		requestID: freshUUID(t), newKV: 2, newAuthPub: newPub,
	})
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, rotateRequest(t, alice.Token, body))
	if w.Code != http.StatusOK {
		t.Fatalf("alice rotate status = %d", w.Code)
	}

	// Bob's profile is untouched (kv unchanged, key unchanged).
	bdata, _ := store.GetObject(context.Background(), keyProfile(bob.UserID))
	var bprof Profile
	json.Unmarshal(bdata, &bprof)
	if bprof.KeyVersion != 1 {
		t.Fatalf("bob profile kv = %d, want 1 (untouched)", bprof.KeyVersion)
	}
	if bprof.AuthPublicKey != b64url.EncodeToString(bob.AuthPub) {
		t.Fatalf("bob profile auth key was modified")
	}
}
