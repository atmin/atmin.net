package main

import (
	"context"
	"encoding/json"
	"time"
)

type Profile struct {
	UserID           string     `json:"user_id"`
	Handle           string     `json:"handle"`
	AuthPublicKey    string     `json:"auth_public_key"`
	SharingPublicKey string     `json:"sharing_public_key"`
	Salt             string     `json:"salt,omitempty"`
	KDF              *KDFParams `json:"kdf,omitempty"`
	KeyVersion       int        `json:"key_version,omitempty"`
	DisplayName      string     `json:"display_name,omitempty"`
	AvatarURL        string     `json:"avatar_url,omitempty"`
	LastActive       string     `json:"last_active,omitempty"`
	CreatedAt        string     `json:"created_at"`
}

// KDFParams are the Argon2id stretching parameters for a v2 account.
// Stored on profile.json next to the salt; surfaced via resolve so a
// returning device can re-derive the same keys from the password.
type KDFParams struct {
	Type string `json:"type"`
	M    uint32 `json:"m"`
	T    uint32 `json:"t"`
	P    uint32 `json:"p"`
}

// publicHandleData is the projection written to handles/{handle}.json.
// salt/kdf/key_version are public per-user values (v2 accounts only);
// senders ignore them, the login fork consumes them.
//
// A handle's lifecycle has two shapes:
//   - Live projection: every field set (UserID, SharingPublicKey, ...).
//   - Tombstone: only ReleasedAt set; all other fields empty. The handle
//     is in 30-day cooldown after account deletion (ADR-0013).
//
// The two shapes coexist at the same S3 path; resolve/register branch on
// the presence and timing of ReleasedAt.
type publicHandleData struct {
	UserID           string     `json:"user_id,omitempty"`
	SharingPublicKey string     `json:"sharing_public_key,omitempty"`
	Salt             string     `json:"salt,omitempty"`
	KDF              *KDFParams `json:"kdf,omitempty"`
	KeyVersion       int        `json:"key_version,omitempty"`
	DisplayName      string     `json:"display_name,omitempty"`
	AvatarURL        string     `json:"avatar_url,omitempty"`
	// ReleasedAt is set only on tombstones — the original account was
	// deleted at this RFC3339 timestamp. The handle becomes claimable
	// at ReleasedAt + handleCooldown.
	ReleasedAt string `json:"released_at,omitempty"`
}

// handleCooldown is the post-deletion reservation window (ADR-0013).
// A tombstone with `released_at + handleCooldown` in the past is stale
// and can be reclaimed by a new registration.
const handleCooldown = 30 * 24 * time.Hour

// getProfile reads users/{uid}/profile.json and unmarshals into Profile.
// Returns ErrNotFound if the profile does not exist.
func getProfile(ctx context.Context, store Store, uid string) (*Profile, error) {
	data, err := store.GetObject(ctx, keyProfile(uid))
	if err != nil {
		return nil, err
	}
	var p Profile
	if err := json.Unmarshal(data, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// putProfile marshals p and writes it to users/{p.UserID}/profile.json.
func putProfile(ctx context.Context, store Store, p *Profile) error {
	data, err := json.Marshal(p)
	if err != nil {
		return err
	}
	return store.PutObject(ctx, keyProfile(p.UserID), data, "application/json")
}

// putHandleProjection writes the public fields of p to handles/{p.Handle}.json.
// No-ops if p.Handle is empty.
func putHandleProjection(ctx context.Context, store Store, p *Profile) error {
	if p.Handle == "" {
		return nil
	}
	h := publicHandleData{
		UserID:           p.UserID,
		SharingPublicKey: p.SharingPublicKey,
		Salt:             p.Salt,
		KDF:              p.KDF,
		KeyVersion:       p.KeyVersion,
		DisplayName:      p.DisplayName,
		AvatarURL:        p.AvatarURL,
	}
	data, _ := json.Marshal(h)
	return store.PutObject(ctx, keyHandle(p.Handle), data, "application/json")
}
