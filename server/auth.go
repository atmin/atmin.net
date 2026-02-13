package main

import (
	"crypto/ed25519"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"strings"
	"time"
)

// b64url is unpadded base64url encoding (RFC 4648 section 5).
var b64url = base64.RawURLEncoding

// Token format: base64url(user_id.device_id.HMAC-SHA256(secret, user_id.device_id))

func generateToken(secret []byte, userID, deviceID string) string {
	payload := userID + "." + deviceID
	mac := computeHMAC(secret, payload)
	raw := payload + "." + b64url.EncodeToString(mac)
	return b64url.EncodeToString([]byte(raw))
}

func parseToken(secret []byte, token string) (userID, deviceID string, err error) {
	raw, err := b64url.DecodeString(token)
	if err != nil {
		return "", "", errors.New("invalid token encoding")
	}

	parts := strings.SplitN(string(raw), ".", 3)
	if len(parts) != 3 {
		return "", "", errors.New("invalid token format")
	}

	userID = parts[0]
	deviceID = parts[1]
	sig, err := b64url.DecodeString(parts[2])
	if err != nil {
		return "", "", errors.New("invalid token signature encoding")
	}

	expected := computeHMAC(secret, userID+"."+deviceID)
	if !hmac.Equal(sig, expected) {
		return "", "", errors.New("invalid token signature")
	}

	return userID, deviceID, nil
}

func computeHMAC(secret []byte, message string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(message))
	return h.Sum(nil)
}

// Auth proof: Ed25519 signature over a JSON payload with timestamp.

type AuthProof struct {
	Payload   AuthProofPayload `json:"payload"`
	Signature string           `json:"signature"` // base64url Ed25519 signature
}

type AuthProofPayload struct {
	UserID    string `json:"user_id"`
	DeviceID  string `json:"device_id"`
	Timestamp string `json:"timestamp"`
}

const authProofMaxAge = 5 * time.Minute

func verifyAuthProof(authPublicKey ed25519.PublicKey, proof AuthProof) error {
	// Verify timestamp is within window
	ts, err := time.Parse(time.RFC3339, proof.Payload.Timestamp)
	if err != nil {
		return fmt.Errorf("invalid timestamp: %w", err)
	}
	age := time.Since(ts)
	if math.Abs(age.Seconds()) > authProofMaxAge.Seconds() {
		return errors.New("auth proof expired")
	}

	// Verify signature over the JSON-encoded payload
	payloadBytes, err := json.Marshal(proof.Payload)
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}

	sig, err := b64url.DecodeString(proof.Signature)
	if err != nil {
		return errors.New("invalid signature encoding")
	}

	if !ed25519.Verify(authPublicKey, payloadBytes, sig) {
		return errors.New("invalid signature")
	}

	return nil
}
