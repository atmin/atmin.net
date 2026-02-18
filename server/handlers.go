package main

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/oklog/ulid/v2"
)

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

// POST /v1/register
func handleRegister(store Store, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			DeviceLabel      string `json:"device_label"`
			AuthPublicKey    string `json:"auth_public_key"`
			SharingPublicKey string `json:"sharing_public_key"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, errBadRequest)
			return
		}
		if req.DeviceLabel == "" || req.AuthPublicKey == "" || req.SharingPublicKey == "" {
			writeError(w, errBadRequest)
			return
		}

		userID := ulid.Make().String()
		deviceID := ulid.Make().String()
		token := generateToken(cfg.ServerSecret, userID, deviceID)

		// Generate invite handle, retry on collision
		var inviteHandle string
		for i := 0; i < 10; i++ {
			candidate := generateInviteHandle()
			inviteKey := "invites/" + candidate + ".json"
			if err := store.HeadObject(r.Context(), inviteKey); errors.Is(err, ErrNotFound) {
				inviteHandle = candidate
				break
			}
		}
		if inviteHandle == "" {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to generate invite handle"})
			return
		}

		// Write profile
		profile, _ := json.Marshal(map[string]string{
			"user_id":            userID,
			"invite_handle":      inviteHandle,
			"auth_public_key":    req.AuthPublicKey,
			"sharing_public_key": req.SharingPublicKey,
			"created_at":         time.Now().UTC().Format(time.RFC3339),
		})
		if err := store.PutObject(r.Context(), "users/"+userID+"/profile.json", profile, "application/json"); err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to write profile"})
			return
		}

		// Write device
		device, _ := json.Marshal(map[string]string{
			"device_id":    deviceID,
			"device_label": req.DeviceLabel,
			"created_at":   time.Now().UTC().Format(time.RFC3339),
		})
		if err := store.PutObject(r.Context(), "users/"+userID+"/devices/"+deviceID+".json", device, "application/json"); err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to write device"})
			return
		}

		// Write invite
		invite, _ := json.Marshal(map[string]string{"user_id": userID, "sharing_public_key": req.SharingPublicKey})
		if err := store.PutObject(r.Context(), "invites/"+inviteHandle+".json", invite, "application/json"); err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to write invite"})
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"user_id":       userID,
			"device_id":     deviceID,
			"token":         token,
			"invite_handle": inviteHandle,
		})
	}
}

// POST /v1/devices
func handleAddDevice(store Store, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			UserID      string    `json:"user_id"`
			AuthProof   AuthProof `json:"auth_proof"`
			DeviceLabel string    `json:"device_label"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, errBadRequest)
			return
		}

		// Fetch profile to get auth public key
		profileData, err := store.GetObject(r.Context(), "users/"+req.UserID+"/profile.json")
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeError(w, errNotFound)
				return
			}
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to read profile"})
			return
		}

		var profile struct {
			AuthPublicKey string `json:"auth_public_key"`
		}
		json.Unmarshal(profileData, &profile)

		pubKeyBytes, err := b64url.DecodeString(profile.AuthPublicKey)
		if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
			writeError(w, errBadRequest)
			return
		}

		if err := verifyAuthProof(ed25519.PublicKey(pubKeyBytes), req.AuthProof); err != nil {
			writeError(w, errForbidden)
			return
		}

		deviceID := req.AuthProof.Payload.DeviceID
		token := generateToken(cfg.ServerSecret, req.UserID, deviceID)

		device, _ := json.Marshal(map[string]string{
			"device_id":    deviceID,
			"device_label": req.DeviceLabel,
			"created_at":   time.Now().UTC().Format(time.RFC3339),
		})
		if err := store.PutObject(r.Context(), "users/"+req.UserID+"/devices/"+deviceID+".json", device, "application/json"); err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to write device"})
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"device_id": deviceID,
			"token":     token,
		})
	}
}

// POST /v1/devices/revoke
func handleRevokeDevice(store Store, cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			DeviceID  string    `json:"device_id"`
			AuthProof AuthProof `json:"auth_proof"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, errBadRequest)
			return
		}

		userID := userIDFrom(r.Context())

		// Fetch profile to get auth public key
		profileData, err := store.GetObject(r.Context(), "users/"+userID+"/profile.json")
		if err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to read profile"})
			return
		}

		var profile struct {
			AuthPublicKey string `json:"auth_public_key"`
		}
		json.Unmarshal(profileData, &profile)

		pubKeyBytes, err := b64url.DecodeString(profile.AuthPublicKey)
		if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
			writeError(w, errBadRequest)
			return
		}

		if err := verifyAuthProof(ed25519.PublicKey(pubKeyBytes), req.AuthProof); err != nil {
			writeError(w, errForbidden)
			return
		}

		if err := store.DeleteObject(r.Context(), "users/"+userID+"/devices/"+req.DeviceID+".json"); err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to delete device"})
			return
		}

		w.WriteHeader(http.StatusOK)
	}
}

// GET /v1/resolve/{invite_handle}
func handleResolve(store Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		handle := r.PathValue("invite_handle")
		if handle == "" {
			writeError(w, errBadRequest)
			return
		}

		inviteData, err := store.GetObject(r.Context(), "invites/"+handle+".json")
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeError(w, errNotFound)
				return
			}
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to read invite"})
			return
		}

		var invite map[string]string
		json.Unmarshal(inviteData, &invite)

		resp := map[string]string{
			"user_id":            invite["user_id"],
			"sharing_public_key": invite["sharing_public_key"],
		}
		if v := invite["display_name"]; v != "" {
			resp["display_name"] = v
		}
		if v := invite["avatar_url"]; v != "" {
			resp["avatar_url"] = v
		}

		// Fallback: if invite lacks sharing_public_key, read from profile
		if resp["sharing_public_key"] == "" {
			profileData, err := store.GetObject(r.Context(), "users/"+invite["user_id"]+"/profile.json")
			if err == nil {
				var profile map[string]string
				json.Unmarshal(profileData, &profile)
				resp["sharing_public_key"] = profile["sharing_public_key"]
			}
		}

		writeJSON(w, http.StatusOK, resp)
	}
}

// PUT /v1/profile
func handleProfile(store Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())

		var req struct {
			DisplayName *string `json:"display_name"`
			AvatarURL   *string `json:"avatar_url"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, errBadRequest)
			return
		}
		if req.DisplayName == nil && req.AvatarURL == nil {
			writeError(w, errBadRequest)
			return
		}

		// Read-merge-write profile.json
		profileData, err := store.GetObject(r.Context(), "users/"+userID+"/profile.json")
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeError(w, errNotFound)
				return
			}
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to read profile"})
			return
		}

		var profile map[string]string
		json.Unmarshal(profileData, &profile)

		if req.DisplayName != nil {
			profile["display_name"] = *req.DisplayName
		}
		if req.AvatarURL != nil {
			profile["avatar_url"] = *req.AvatarURL
		}

		updated, _ := json.Marshal(profile)
		if err := store.PutObject(r.Context(), "users/"+userID+"/profile.json", updated, "application/json"); err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to write profile"})
			return
		}

		// Project public fields to invite file
		handle := profile["invite_handle"]
		if handle != "" {
			invite, _ := json.Marshal(map[string]string{
				"user_id":            userID,
				"sharing_public_key": profile["sharing_public_key"],
				"display_name":       profile["display_name"],
				"avatar_url":         profile["avatar_url"],
			})
			store.PutObject(r.Context(), "invites/"+handle+".json", invite, "application/json")
		}

		w.WriteHeader(http.StatusOK)
	}
}

// DELETE /v1/profile
func handleDeleteProfile(store Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())

		// Read profile to get invite_handle
		profileData, err := store.GetObject(r.Context(), "users/"+userID+"/profile.json")
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeError(w, errNotFound)
				return
			}
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to read profile"})
			return
		}

		var profile map[string]string
		json.Unmarshal(profileData, &profile)

		// Delete all objects under each prefix
		for _, prefix := range []string{
			"users/" + userID + "/",
			"inbox/" + userID + "/",
			"backups/" + userID + "/",
			"media/" + userID + "/",
		} {
			keys, _, err := store.ListObjects(r.Context(), prefix, 1000, "")
			if err != nil {
				writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to list objects"})
				return
			}
			if len(keys) > 0 {
				if err := store.DeleteObjects(r.Context(), keys); err != nil {
					writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to delete objects"})
					return
				}
			}
		}

		// Delete invite file
		if handle := profile["invite_handle"]; handle != "" {
			store.DeleteObject(r.Context(), "invites/"+handle+".json")
		}

		w.WriteHeader(http.StatusOK)
	}
}

// POST /v1/send
func handleSend(store Store, hub *EventHub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())
		deviceID := deviceIDFrom(r.Context())

		var req struct {
			Envelopes []json.RawMessage `json:"envelopes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, errBadRequest)
			return
		}

		// Track unique recipients for notifications
		recipients := make(map[string]bool)

		for _, raw := range req.Envelopes {
			var env struct {
				ToUser     string `json:"to_user"`
				FromUser   string `json:"from_user"`
				FromDevice string `json:"from_device"`
				MsgID      string `json:"msg_id"`
			}
			if err := json.Unmarshal(raw, &env); err != nil {
				writeError(w, errBadRequest)
				return
			}

			// Verify sender identity matches token
			if env.FromUser != userID || env.FromDevice != deviceID {
				writeError(w, errForbidden)
				return
			}

			key := "inbox/" + env.ToUser + "/live/" + env.MsgID
			if err := store.PutObject(r.Context(), key, raw, "application/json"); err != nil {
				writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to write envelope"})
				return
			}

			recipients[env.ToUser] = true
		}

		// Notify recipients of new messages via SSE
		for toUser := range recipients {
			hub.Notify(toUser, "new_message")
		}

		w.WriteHeader(http.StatusOK)
	}
}

// Prefix authorization: users can only access their own prefixes.
var allowedPrefixes = []string{"inbox/", "backups/", "media/"}

func authorizePrefix(userID, prefix string) bool {
	for _, p := range allowedPrefixes {
		if strings.HasPrefix(prefix, p+userID+"/") {
			return true
		}
	}
	// Also allow reading other users' profiles (for resolve/key fetch)
	if strings.HasPrefix(prefix, "users/") {
		return true
	}
	return false
}

func authorizeKey(userID, key string) bool {
	for _, p := range allowedPrefixes {
		if strings.HasPrefix(key, p+userID+"/") {
			return true
		}
	}
	if strings.HasPrefix(key, "users/") {
		return true
	}
	return false
}

// authorizeKeyWrite is like authorizeKey but restricts users/ to own uid only.
func authorizeKeyWrite(userID, key string) bool {
	for _, p := range allowedPrefixes {
		if strings.HasPrefix(key, p+userID+"/") {
			return true
		}
	}
	if strings.HasPrefix(key, "users/"+userID+"/") {
		return true
	}
	return false
}

// GET /v1/store/list
func handleStoreList(store Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())
		prefix := r.URL.Query().Get("prefix")
		cursor := r.URL.Query().Get("cursor")
		if prefix == "" {
			writeError(w, errBadRequest)
			return
		}
		if !authorizePrefix(userID, prefix) {
			writeError(w, errForbidden)
			return
		}

		limit := 50 // default
		keys, nextCursor, err := store.ListObjects(r.Context(), prefix, limit, cursor)
		if err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "List failed"})
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"keys":        keys,
			"next_cursor": nextCursor,
		})
	}
}

// GET /v1/store/object
func handleStoreObject(store Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())
		key := r.URL.Query().Get("key")
		if key == "" {
			writeError(w, errBadRequest)
			return
		}
		if !authorizeKey(userID, key) {
			writeError(w, errForbidden)
			return
		}

		data, err := store.GetObject(r.Context(), key)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeError(w, errNotFound)
				return
			}
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Get failed"})
			return
		}

		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(data)
	}
}

// POST /v1/store/presign
func handleStorePresign(store Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())

		var req struct {
			Key   string `json:"key"`
			Bytes int64  `json:"bytes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, errBadRequest)
			return
		}
		if req.Key == "" || req.Bytes <= 0 {
			writeError(w, errBadRequest)
			return
		}
		if !authorizeKeyWrite(userID, req.Key) {
			writeError(w, errForbidden)
			return
		}

		url, err := store.PresignPut(r.Context(), req.Key, req.Bytes, 15*time.Minute)
		if err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Presign failed"})
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"presigned_url": url,
		})
	}
}

// POST /v1/store/compact
func handleStoreCompact(store Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())

		var req struct {
			Prefix string `json:"prefix"`
			UpTo   string `json:"up_to"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, errBadRequest)
			return
		}
		if req.Prefix == "" || req.UpTo == "" {
			writeError(w, errBadRequest)
			return
		}
		if !authorizePrefix(userID, req.Prefix) {
			writeError(w, errForbidden)
			return
		}

		// Collect all keys under prefix up to boundary (inclusive).
		// Archive keys sort after ULIDs ('a' > '0') so they are naturally excluded.
		boundary := req.Prefix + req.UpTo
		var toCompact []string
		cursor := ""
		for {
			keys, nextCursor, err := store.ListObjects(r.Context(), req.Prefix, 100, cursor)
			if err != nil {
				writeError(w, APIError{http.StatusInternalServerError, "internal", "List failed"})
				return
			}
			for _, k := range keys {
				if k <= boundary {
					toCompact = append(toCompact, k)
				}
			}
			if nextCursor == "" || (len(keys) > 0 && keys[len(keys)-1] > boundary) {
				break
			}
			cursor = nextCursor
		}

		if len(toCompact) == 0 {
			writeJSON(w, http.StatusOK, map[string]any{
				"archived":    0,
				"archive_key": "",
			})
			return
		}

		// Read new live objects, decode JSON into generic maps for CBOR encoding.
		newObjects := make([]any, 0, len(toCompact))
		for _, key := range toCompact {
			data, err := store.GetObject(r.Context(), key)
			if err != nil {
				if errors.Is(err, ErrNotFound) {
					continue // deleted between list and get, skip
				}
				writeError(w, APIError{http.StatusInternalServerError, "internal", "Read failed"})
				return
			}
			var obj any
			if err := json.Unmarshal(data, &obj); err != nil {
				writeError(w, APIError{http.StatusInternalServerError, "internal", "Decode failed"})
				return
			}
			newObjects = append(newObjects, obj)
		}

		// Find existing same-day archives to merge with.
		today := time.Now().UTC().Format("2006-01-02")
		archivePrefix := req.Prefix + "archive/" + today
		var existingArchiveKeys []string
		cursor = ""
		for {
			keys, nextCursor, err := store.ListObjects(r.Context(), archivePrefix, 100, cursor)
			if err != nil {
				writeError(w, APIError{http.StatusInternalServerError, "internal", "List archives failed"})
				return
			}
			existingArchiveKeys = append(existingArchiveKeys, keys...)
			if nextCursor == "" {
				break
			}
			cursor = nextCursor
		}

		// Read and decode existing archives.
		var existingObjects []any
		for _, key := range existingArchiveKeys {
			data, err := store.GetObject(r.Context(), key)
			if err != nil {
				if errors.Is(err, ErrNotFound) {
					continue
				}
				writeError(w, APIError{http.StatusInternalServerError, "internal", "Read archive failed"})
				return
			}
			var objs []any
			if err := cbor.Unmarshal(data, &objs); err != nil {
				writeError(w, APIError{http.StatusInternalServerError, "internal", "CBOR decode failed"})
				return
			}
			existingObjects = append(existingObjects, objs...)
		}

		// Merge: existing archive objects first (preserves order), then new objects.
		// Deduplicate by msg_id; objects without msg_id are always kept.
		merged := deduplicateByMsgID(append(existingObjects, newObjects...))

		// Encode as CBOR array.
		archive, err := cbor.Marshal(merged)
		if err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "CBOR encode failed"})
			return
		}

		// Write archive with ULID suffix for uniqueness.
		// No object is deleted before the new archive is durably written.
		archiveKey := req.Prefix + "archive/" + today + "-" + ulid.Make().String()
		if err := store.PutObject(r.Context(), archiveKey, archive, "application/cbor"); err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Write archive failed"})
			return
		}

		// Delete compacted live objects and old archives.
		toDelete := append(toCompact, existingArchiveKeys...)
		if err := store.DeleteObjects(r.Context(), toDelete); err != nil {
			writeError(w, APIError{http.StatusInternalServerError, "internal", "Delete failed"})
			return
		}

		writeJSON(w, http.StatusOK, map[string]any{
			"archived":    len(newObjects),
			"archive_key": archiveKey,
		})
	}
}

// deduplicateByMsgID removes duplicate envelopes by msg_id.
// Objects without a msg_id field (e.g. key backups) are always kept.
// Handles both map[string]any (from JSON) and map[any]any (from CBOR).
func deduplicateByMsgID(objects []any) []any {
	seen := make(map[string]bool)
	result := make([]any, 0, len(objects))
	for _, obj := range objects {
		msgID, ok := extractMsgID(obj)
		if ok && seen[msgID] {
			continue
		}
		if ok {
			seen[msgID] = true
		}
		result = append(result, obj)
	}
	return result
}

func extractMsgID(obj any) (string, bool) {
	switch m := obj.(type) {
	case map[string]any:
		id, ok := m["msg_id"].(string)
		return id, ok
	case map[any]any:
		id, ok := m["msg_id"].(string)
		return id, ok
	}
	return "", false
}
