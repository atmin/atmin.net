package main

import (
	"crypto/ed25519"
	"encoding/json"
	"testing"
	"time"

	"github.com/gowebpki/jcs"
)

func TestTokenRoundTrip(t *testing.T) {
	secret := []byte("test-secret")
	userID := "01HWQA1234567890ABCDEF"
	deviceID := "01HWQA0987654321FEDCBA"

	token := generateToken(secret, userID, deviceID, 1)
	gotUser, gotDevice, gotKV, err := parseToken(secret, token)
	if err != nil {
		t.Fatalf("parseToken: %v", err)
	}
	if gotUser != userID {
		t.Errorf("userID = %q, want %q", gotUser, userID)
	}
	if gotDevice != deviceID {
		t.Errorf("deviceID = %q, want %q", gotDevice, deviceID)
	}
	if gotKV != 1 {
		t.Errorf("keyVersion = %d, want 1", gotKV)
	}
}

func TestTokenRoundTripV2KeyVersion(t *testing.T) {
	secret := []byte("test-secret")
	token := generateToken(secret, "u1", "d1", 7)
	_, _, gotKV, err := parseToken(secret, token)
	if err != nil {
		t.Fatalf("parseToken: %v", err)
	}
	if gotKV != 7 {
		t.Fatalf("keyVersion = %d, want 7", gotKV)
	}
}

func TestTokenRejectsLegacyV1(t *testing.T) {
	// A synthetic 3-segment (no-kv) token — the legacy v1 shape — must no
	// longer parse. Pins the removal so a refactor can't reintroduce it.
	secret := []byte("test-secret")
	payload := "user1.dev1"
	mac := computeHMAC(secret, payload)
	raw := payload + "." + b64url.EncodeToString(mac)
	legacy := b64url.EncodeToString([]byte(raw))

	if _, _, _, err := parseToken(secret, legacy); err == nil {
		t.Fatal("expected legacy 3-segment token to be rejected")
	}
}

func TestTokenV2TamperedKeyVersionRejected(t *testing.T) {
	secret := []byte("test-secret")
	// Build a v2 token at kv=1, then swap the kv segment to 99 — HMAC must reject.
	token := generateToken(secret, "u1", "d1", 1)
	rawBytes, _ := b64url.DecodeString(token)
	raw := string(rawBytes)
	// raw = "u1.d1.1.<sig>"; replace the third segment.
	parts := []rune(raw)
	_ = parts
	tampered := "u1.d1.99." + raw[len("u1.d1.1."):]
	tamperedToken := b64url.EncodeToString([]byte(tampered))
	if _, _, _, err := parseToken(secret, tamperedToken); err == nil {
		t.Fatal("expected error for tampered key_version")
	}
}

func TestTokenWrongSecret(t *testing.T) {
	token := generateToken([]byte("secret-a"), "user1", "dev1", 1)
	_, _, _, err := parseToken([]byte("secret-b"), token)
	if err == nil {
		t.Fatal("expected error for wrong secret")
	}
}

func TestTokenTampered(t *testing.T) {
	token := generateToken([]byte("secret"), "user1", "dev1", 1)
	// Flip a character
	tampered := []byte(token)
	tampered[0] ^= 0xff
	_, _, _, err := parseToken([]byte("secret"), string(tampered))
	if err == nil {
		t.Fatal("expected error for tampered token")
	}
}

func TestTokenEmptyInput(t *testing.T) {
	_, _, _, err := parseToken([]byte("secret"), "")
	if err == nil {
		t.Fatal("expected error for empty token")
	}
}

// buildAuthProof builds a canonical (JCS + key_version) auth proof and
// unmarshals it back into the AuthProof type, capturing payloadRaw the way
// the real request path does.
func buildAuthProof(t *testing.T, priv ed25519.PrivateKey, userID, deviceID string, kv int, ts string) AuthProof {
	t.Helper()
	payload := map[string]any{
		"user_id":     userID,
		"device_id":   deviceID,
		"timestamp":   ts,
		"key_version": kv,
	}
	raw, _ := json.Marshal(payload)
	canonical, err := jcs.Transform(raw)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	sig := ed25519.Sign(priv, canonical)
	wire, _ := json.Marshal(map[string]any{
		"payload":   payload,
		"signature": b64url.EncodeToString(sig),
	})
	var proof AuthProof
	if err := json.Unmarshal(wire, &proof); err != nil {
		t.Fatalf("unmarshal proof: %v", err)
	}
	return proof
}

func TestAuthProofValid(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	proof := buildAuthProof(t, priv, "user1", "dev1", 1, time.Now().UTC().Format(time.RFC3339))
	if err := verifyAuthProof(pub, proof); err != nil {
		t.Fatalf("verifyAuthProof: %v", err)
	}
}

func TestAuthProofExpired(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)
	old := time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339)
	proof := buildAuthProof(t, priv, "user1", "dev1", 1, old)
	if err := verifyAuthProof(pub, proof); err == nil {
		t.Fatal("expected error for expired proof")
	}
}

func TestAuthProofV2_JCSRoundTrip(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)

	payload := map[string]any{
		"user_id":     "u1",
		"device_id":   "d1",
		"timestamp":   time.Now().UTC().Format(time.RFC3339),
		"key_version": 2,
	}
	rawPayload, _ := json.Marshal(payload)

	// Client signs the JCS-canonical bytes; server must verify against the same.
	canonical, err := jcs.Transform(rawPayload)
	if err != nil {
		t.Fatalf("canonicalize: %v", err)
	}
	sig := ed25519.Sign(priv, canonical)

	wire, _ := json.Marshal(map[string]any{
		"payload":   payload,
		"signature": b64url.EncodeToString(sig),
	})

	var proof AuthProof
	if err := json.Unmarshal(wire, &proof); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if proof.Payload.KeyVersion != 2 {
		t.Fatalf("Payload.KeyVersion = %d, want 2", proof.Payload.KeyVersion)
	}
	if err := verifyAuthProof(pub, proof); err != nil {
		t.Fatalf("verifyAuthProof v2: %v", err)
	}
}

func TestAuthProofV2_WrongCanonicalRejected(t *testing.T) {
	// A v2 payload signed over its plain JSON.marshal bytes (NOT JCS) must
	// fail verification — the canonicalization mismatch is the whole point
	// of the v2 path. Catches a client that forgets to canonicalize.
	pub, priv, _ := ed25519.GenerateKey(nil)
	payload := map[string]any{
		"user_id":     "u1",
		"device_id":   "d1",
		"timestamp":   time.Now().UTC().Format(time.RFC3339),
		"key_version": 2,
	}
	raw, _ := json.Marshal(payload)
	sig := ed25519.Sign(priv, raw) // <-- signs the non-canonical bytes

	wire, _ := json.Marshal(map[string]any{
		"payload":   payload,
		"signature": b64url.EncodeToString(sig),
	})
	var proof AuthProof
	_ = json.Unmarshal(wire, &proof)

	// Map iteration order in json.Marshal is sorted by key, which for this
	// payload happens to be {device_id, key_version, timestamp, user_id} —
	// i.e. exactly the JCS order. To make the test meaningful we have to
	// sign bytes that differ from the canonical form, so use a permutation.
	permuted := []byte(`{"user_id":"u1","device_id":"d1","timestamp":"` + time.Now().UTC().Format(time.RFC3339) + `","key_version":2}`)
	badSig := ed25519.Sign(priv, permuted)
	wire2, _ := json.Marshal(map[string]any{
		"payload":   payload,
		"signature": b64url.EncodeToString(badSig),
	})
	var proof2 AuthProof
	_ = json.Unmarshal(wire2, &proof2)
	if err := verifyAuthProof(pub, proof2); err == nil {
		t.Fatal("expected verification to fail on non-canonical signed bytes")
	}
}

func TestAuthProofWrongKey(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	otherPub, _, _ := ed25519.GenerateKey(nil)
	proof := buildAuthProof(t, priv, "user1", "dev1", 1, time.Now().UTC().Format(time.RFC3339))
	if err := verifyAuthProof(otherPub, proof); err == nil {
		t.Fatal("expected error for wrong public key")
	}
}
