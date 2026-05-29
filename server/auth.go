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

// Token wire format (per ADR-0012):
//
//	base64url(uid || "." || did || "." || kv || "." || HMAC-SHA256(secret, uid || "." || did || "." || kv))
//
// kv (key_version) is covered by the HMAC, so a stolen token cannot have its
// key_version rewritten by an attacker. Tokens are always 4 segments; the
// legacy 3-segment (no-kv) shape is no longer accepted.

func generateToken(secret []byte, userID, deviceID string, keyVersion int) string {
	if keyVersion < 1 {
		keyVersion = 1
	}
	payload := fmt.Sprintf("%s.%s.%d", userID, deviceID, keyVersion)
	mac := computeHMAC(secret, payload)
	raw := payload + "." + b64url.EncodeToString(mac)
	return b64url.EncodeToString([]byte(raw))
}

// parseToken decodes a 4-segment token (uid.did.kv.sig) and verifies its HMAC.
// Any other shape — including the legacy 3-segment (no-kv) form — is rejected.
func parseToken(secret []byte, token string) (userID, deviceID string, keyVersion int, err error) {
	raw, decodeErr := b64url.DecodeString(token)
	if decodeErr != nil {
		return "", "", 0, errors.New("invalid token encoding")
	}

	parts := strings.Split(string(raw), ".")
	if len(parts) != 4 {
		return "", "", 0, errors.New("invalid token format")
	}
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
}

func computeHMAC(secret []byte, message string) []byte {
	h := hmac.New(sha256.New, secret)
	h.Write([]byte(message))
	return h.Sum(nil)
}

// Auth proof: Ed25519 signature over a JSON payload with timestamp.
//
// Every payload carries a `key_version` field and is signed over its
// JCS-canonicalized (RFC 8785) byte sequence. The legacy shape (no
// `key_version`, verified against a plain `json.Marshal` of the typed
// struct) is no longer accepted — there is a single auth-proof shape.

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
	if proof.Payload.KeyVersion < 1 {
		return errors.New("auth proof missing key_version")
	}

	sig, err := b64url.DecodeString(proof.Signature)
	if err != nil {
		return errors.New("invalid signature encoding")
	}

	// The payload carries `key_version` and is signed over its JCS bytes.
	canonical, err := jcs.Transform(proof.payloadRaw)
	if err != nil {
		return fmt.Errorf("canonicalize payload: %w", err)
	}
	if !ed25519.Verify(authPublicKey, canonical, sig) {
		return errors.New("invalid signature")
	}
	return nil
}
