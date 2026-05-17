package main

import (
	"context"
	"encoding/json"
)

type Profile struct {
	UserID           string `json:"user_id"`
	Handle           string `json:"handle"`
	AuthPublicKey    string `json:"auth_public_key"`
	SharingPublicKey string `json:"sharing_public_key"`
	DisplayName      string `json:"display_name,omitempty"`
	AvatarURL        string `json:"avatar_url,omitempty"`
	LastActive       string `json:"last_active,omitempty"`
	CreatedAt        string `json:"created_at"`
}

// publicHandleData is the projection written to handles/{handle}.json.
type publicHandleData struct {
	UserID           string `json:"user_id"`
	SharingPublicKey string `json:"sharing_public_key"`
	DisplayName      string `json:"display_name,omitempty"`
	AvatarURL        string `json:"avatar_url,omitempty"`
}

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
		DisplayName:      p.DisplayName,
		AvatarURL:        p.AvatarURL,
	}
	data, _ := json.Marshal(h)
	return store.PutObject(ctx, keyHandle(p.Handle), data, "application/json")
}
