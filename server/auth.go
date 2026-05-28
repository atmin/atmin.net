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
	"strconv"
	"strings"
	"time"

	"github.com/gowebpki/jcs"
)

// b64url is unpadded base64url encoding (RFC 4648 section 5).
var b64url = base64.RawURLEncoding

// Token wire format (v2, per ADR-0012):
//
//	base64url(uid || "." || did || "." || kv || "." || HMAC-SHA256(secret, uid || "." || did || "." || kv))
//
// kv (key_version) is covered by the HMAC, so a stolen v1 token cannot be
// upgraded to v2 by an attacker. v1 tokens (3 segments, no kv) are still
// accepted at parse time as kv = 1 — that's the rehearsal-of-protocol-upgrade
// behaviour ADR-0011/0012 calls for. New tokens are always minted v2.

func generateToken(secret []byte, userID, deviceID string, keyVersion int) string {
	if keyVersion < 1 {
		keyVersion = 1
	}
	payload := fmt.Sprintf("%s.%s.%d", userID, deviceID, keyVersion)
	mac := computeHMAC(secret, payload)
	raw := payload + "." + b64url.EncodeToString(mac)
	return b64url.EncodeToString([]byte(raw))
}

// parseToken accepts both v1 (3 segments → kv = 1) and v2 (4 segments → embedded kv).
func parseToken(secret []byte, token string) (userID, deviceID string, keyVersion int, err error) {
	raw, decodeErr := b64url.DecodeString(token)
	if decodeErr != nil {
		return "", "", 0, errors.New("invalid token encoding")
	}

	parts := strings.Split(string(raw), ".")
	switch len(parts) {
	case 3:
		userID, deviceID = parts[0], parts[1]
		sig, sErr := b64url.DecodeString(parts[2])
		if sErr != nil {
			return "", "", 0, errors.New("invalid token signature encoding")
		}
		expected := computeHMAC(secret, userID+"."+deviceID)
		if !hmac.Equal(sig, expected) {
			return "", "", 0, errors.New("invalid token signature")
		}
		return userID, deviceID, 1, nil
	case 4:
		userID, deviceID = parts[0], parts[1]
		kv, kvErr := strconv.Atoi(parts[2])
		if kvErr != nil || kv < 1 {
			return "", "", 0, errors.New("invalid token key_version")
		}
		sig, sErr := b64url.DecodeString(parts[3])
		if sErr != nil {
			return "", "", 0, errors.New("invalid token signature encoding")
		}
		expected := computeHMAC(secret, userID+"."+deviceID+"."+parts[2])
		if !hmac.Equal(sig, expected) {
			return "", "", 0, errors.New("invalid token signature")
		}
		return userID, deviceID, kv, nil
	default:
		return "", "", 0, errors.New("invalid token format")
	}
}

func computeHMAC(secret []byte, message string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(message))
	return h.Sum(nil)
}

// Auth proof: Ed25519 signature over a JSON payload with timestamp.
//
// v2 payloads carry a `key_version` field and are signed over their
// JCS-canonicalized (RFC 8785) byte sequence — used by rotate-keys, and by
// add-device/revoke-device once an account's key_version exceeds 1.
// v1 payloads omit `key_version` and are verified against the legacy
// `json.Marshal` byte sequence of the typed AuthProofPayload struct
// (which happens to match `JSON.stringify` of `{user_id, device_id, timestamp}`).
// v1 proofs are never regenerated on the server.

type AuthProof struct {
	Payload   AuthProofPayload `json:"payload"`
	Signature string           `json:"signature"`

	// payloadRaw is the as-received bytes of the `payload` field,
	// captured for v2 JCS-canonical verification. UnmarshalJSON sets it.
	payloadRaw json.RawMessage
}

type AuthProofPayload struct {
	UserID     string `json:"user_id"`
	DeviceID   string `json:"device_id"`
	Timestamp  string `json:"timestamp"`
	KeyVersion int    `json:"key_version,omitempty"`
}

// UnmarshalJSON keeps the raw payload bytes alongside the typed struct, so v2
// verification can re-canonicalize what the client signed without trusting
// our own re-marshal of the typed struct.
func (p *AuthProof) UnmarshalJSON(data []byte) error {
	var tmp struct {
		Payload   json.RawMessage `json:"payload"`
		Signature string          `json:"signature"`
	}
	if err := json.Unmarshal(data, &tmp); err != nil {
		return err
	}
	p.payloadRaw = tmp.Payload
	p.Signature = tmp.Signature
	if len(tmp.Payload) == 0 {
		return errors.New("auth proof missing payload")
	}
	return json.Unmarshal(tmp.Payload, &p.Payload)
}

const authProofMaxAge = 5 * time.Minute

func verifyAuthProof(authPublicKey ed25519.PublicKey, proof AuthProof) error {
	ts, err := time.Parse(time.RFC3339, proof.Payload.Timestamp)
	if err != nil {
		return fmt.Errorf("invalid timestamp: %w", err)
	}
	if math.Abs(time.Since(ts).Seconds()) > authProofMaxAge.Seconds() {
		return errors.New("auth proof expired")
	}

	sig, err := b64url.DecodeString(proof.Signature)
	if err != nil {
		return errors.New("invalid signature encoding")
	}

	// v2 path: the payload carries `key_version`, signed over JCS bytes.
	if proof.Payload.KeyVersion > 0 {
		canonical, err := jcs.Transform(proof.payloadRaw)
		if err != nil {
			return fmt.Errorf("canonicalize payload: %w", err)
		}
		if !ed25519.Verify(authPublicKey, canonical, sig) {
			return errors.New("invalid signature")
		}
		return nil
	}

	// v1 path: legacy JSON.marshal of the typed payload.
	payloadBytes, err := json.Marshal(AuthProofPayload{
		UserID:    proof.Payload.UserID,
		DeviceID:  proof.Payload.DeviceID,
		Timestamp: proof.Payload.Timestamp,
	})
	if err != nil {
		return fmt.Errorf("failed to marshal payload: %w", err)
	}
	if !ed25519.Verify(authPublicKey, payloadBytes, sig) {
		return errors.New("invalid signature")
	}
	return nil
}
