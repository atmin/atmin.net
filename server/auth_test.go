package main

import (
	"crypto/ed25519"
	"encoding/json"
	"testing"
	"time"
)

func TestTokenRoundTrip(t *testing.T) {
	secret := []byte("test-secret")
	userID := "01HWQA1234567890ABCDEF"
	deviceID := "01HWQA0987654321FEDCBA"

	token := generateToken(secret, userID, deviceID)
	gotUser, gotDevice, err := parseToken(secret, token)
	if err != nil {
		t.Fatalf("parseToken: %v", err)
	}
	if gotUser != userID {
		t.Errorf("userID = %q, want %q", gotUser, userID)
	}
	if gotDevice != deviceID {
		t.Errorf("deviceID = %q, want %q", gotDevice, deviceID)
	}
}

func TestTokenWrongSecret(t *testing.T) {
	token := generateToken([]byte("secret-a"), "user1", "dev1")
	_, _, err := parseToken([]byte("secret-b"), token)
	if err == nil {
		t.Fatal("expected error for wrong secret")
	}
}

func TestTokenTampered(t *testing.T) {
	token := generateToken([]byte("secret"), "user1", "dev1")
	// Flip a character
	tampered := []byte(token)
	tampered[0] ^= 0xff
	_, _, err := parseToken([]byte("secret"), string(tampered))
	if err == nil {
		t.Fatal("expected error for tampered token")
	}
}

func TestTokenEmptyInput(t *testing.T) {
	_, _, err := parseToken([]byte("secret"), "")
	if err == nil {
		t.Fatal("expected error for empty token")
	}
}

func TestAuthProofValid(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)

	payload := AuthProofPayload{
		UserID:    "user1",
		DeviceID:  "dev1",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}

	payloadBytes, _ := json.Marshal(payload)
	sig := ed25519.Sign(priv, payloadBytes)

	proof := AuthProof{
		Payload:   payload,
		Signature: b64url.EncodeToString(sig),
	}

	if err := verifyAuthProof(pub, proof); err != nil {
		t.Fatalf("verifyAuthProof: %v", err)
	}
}

func TestAuthProofExpired(t *testing.T) {
	pub, priv, _ := ed25519.GenerateKey(nil)

	payload := AuthProofPayload{
		UserID:    "user1",
		DeviceID:  "dev1",
		Timestamp: time.Now().Add(-10 * time.Minute).UTC().Format(time.RFC3339),
	}

	payloadBytes, _ := json.Marshal(payload)
	sig := ed25519.Sign(priv, payloadBytes)

	proof := AuthProof{
		Payload:   payload,
		Signature: b64url.EncodeToString(sig),
	}

	if err := verifyAuthProof(pub, proof); err == nil {
		t.Fatal("expected error for expired proof")
	}
}

func TestAuthProofWrongKey(t *testing.T) {
	_, priv, _ := ed25519.GenerateKey(nil)
	otherPub, _, _ := ed25519.GenerateKey(nil)

	payload := AuthProofPayload{
		UserID:    "user1",
		DeviceID:  "dev1",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}

	payloadBytes, _ := json.Marshal(payload)
	sig := ed25519.Sign(priv, payloadBytes)

	proof := AuthProof{
		Payload:   payload,
		Signature: b64url.EncodeToString(sig),
	}

	if err := verifyAuthProof(otherPub, proof); err == nil {
		t.Fatal("expected error for wrong public key")
	}
}
