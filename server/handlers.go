package main

import (
	"context"
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
			DeviceLabel      string     `json:"device_label"`
			AuthPublicKey    string     `json:"auth_public_key"`
			SharingPublicKey string     `json:"sharing_public_key"`
			Salt             string     `json:"salt"`
			KDF              *KDFParams `json:"kdf"`
		}
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, errBadRequest)
			return
		}
		if req.DeviceLabel == "" || req.AuthPublicKey == "" || req.SharingPublicKey == "" {
			writeError(w, errBadRequest)
			return
		}

		// Credential params: both present (v2) or both absent (v1).
		// A partial set, or malformed v2 params, is a bad request.
		hasSalt := req.Salt != ""
		hasKDF := req.KDF != nil
		if hasSalt != hasKDF {
			writeError(w, errBadRequest)
			return
		}
		if hasKDF && !validKDFParams(req.Salt, req.KDF) {
			writeError(w, errBadRequest)
			return
		}

		userID := ulid.Make().String()
		deviceID := ulid.Make().String()
		token := generateToken(cfg.ServerSecret, userID, deviceID)

		// Generate handle, retry on collision
		var handle string
		for i := 0; i < 10; i++ {
			candidate := generateHandle()
			handleKey := keyHandle(candidate)
			if err := store.HeadObject(r.Context(), handleKey); errors.Is(err, ErrNotFound) {
				handle = candidate
				break
			}
		}
		if handle == "" {
			internalError(w, "Failed to generate handle")
			return
		}

		p := &Profile{
			UserID:           userID,
			Handle:           handle,
			AuthPublicKey:    req.AuthPublicKey,
			SharingPublicKey: req.SharingPublicKey,
			CreatedAt:        time.Now().UTC().Format(time.RFC3339),
		}
		if hasKDF {
			// v2 account: rotation counter starts at 1.
			p.Salt = req.Salt
			p.KDF = req.KDF
			p.KeyVersion = 1
		}
		if err := putProfile(r.Context(), store, p); err != nil {
			internalError(w, "Failed to write profile")
			return
		}

		// Write device
		device, _ := json.Marshal(map[string]string{
			"device_id":    deviceID,
			"device_label": req.DeviceLabel,
			"created_at":   time.Now().UTC().Format(time.RFC3339),
		})
		if err := store.PutObject(r.Context(), keyDevice(userID, deviceID), device, "application/json"); err != nil {
			internalError(w, "Failed to write device")
			return
		}

		if err := putHandleProjection(r.Context(), store, p); err != nil {
			internalError(w, "Failed to write handle")
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"user_id":   userID,
			"device_id": deviceID,
			"token":     token,
			"handle":    handle,
		})
	}
}

// validKDFParams checks a v2 account's Argon2id parameters and salt. The
// server does not set the security floor (the client picks reasonable
// params) but it refuses values that would brick the account or pin
// unrealistic cost: m in [8 KiB, 1 GiB], t in [1, 16], p in [1, 8], and
// a salt that decodes to exactly 16 bytes.
func validKDFParams(salt string, kdf *KDFParams) bool {
	if kdf.Type != "argon2id" {
		return false
	}
	if kdf.M < 8 || kdf.M > 1048576 {
		return false
	}
	if kdf.T < 1 || kdf.T > 16 {
		return false
	}
	if kdf.P < 1 || kdf.P > 8 {
		return false
	}
	saltBytes, err := b64url.DecodeString(salt)
	if err != nil || len(saltBytes) != 16 {
		return false
	}
	return true
}

// errAuthProofInvalid is returned by fetchAndVerifyAuthProof when the key is
// malformed or the proof signature/timestamp is invalid.
var errAuthProofInvalid = errors.New("auth proof invalid")

// fetchAndVerifyAuthProof fetches the user's profile to get their auth public key,
// then verifies the auth proof. Returns ErrNotFound if the profile does not exist.
func fetchAndVerifyAuthProof(ctx context.Context, store Store, userID string, proof AuthProof) error {
	p, err := getProfile(ctx, store, userID)
	if err != nil {
		return err
	}
	pubKeyBytes, err := b64url.DecodeString(p.AuthPublicKey)
	if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
		return errAuthProofInvalid
	}
	if err := verifyAuthProof(ed25519.PublicKey(pubKeyBytes), proof); err != nil {
		return errAuthProofInvalid
	}
	return nil
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

		if err := fetchAndVerifyAuthProof(r.Context(), store, req.UserID, req.AuthProof); err != nil {
			switch {
			case errors.Is(err, ErrNotFound):
				writeError(w, errNotFound)
			case errors.Is(err, errAuthProofInvalid):
				writeError(w, errForbidden)
			default:
				internalError(w, "Failed to verify auth proof")
			}
			return
		}

		deviceID := req.AuthProof.Payload.DeviceID
		token := generateToken(cfg.ServerSecret, req.UserID, deviceID)

		device, _ := json.Marshal(map[string]string{
			"device_id":    deviceID,
			"device_label": req.DeviceLabel,
			"created_at":   time.Now().UTC().Format(time.RFC3339),
		})
		if err := store.PutObject(r.Context(), keyDevice(req.UserID, deviceID), device, "application/json"); err != nil {
			internalError(w, "Failed to write device")
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"device_id": deviceID,
			"token":     token,
		})
	}
}

// DELETE /v1/devices — self-delete the calling device (token-auth only, no mnemonic).
func handleDeleteDevice(store Store, cache *deviceCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())
		deviceID := deviceIDFrom(r.Context())

		deviceKey := keyDevice(userID, deviceID)
		if err := store.DeleteObject(r.Context(), deviceKey); err != nil {
			internalError(w, "Failed to delete device")
			return
		}
		cache.invalidate(deviceKey)
		w.WriteHeader(http.StatusOK)
	}
}

// POST /v1/devices/revoke
func handleRevokeDevice(store Store, cfg Config, cache *deviceCache) http.HandlerFunc {
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

		if err := fetchAndVerifyAuthProof(r.Context(), store, userID, req.AuthProof); err != nil {
			if errors.Is(err, errAuthProofInvalid) {
				writeError(w, errForbidden)
			} else {
				internalError(w, "Failed to verify auth proof")
			}
			return
		}

		deviceKey := keyDevice(userID, req.DeviceID)
		if err := store.DeleteObject(r.Context(), deviceKey); err != nil {
			internalError(w, "Failed to delete device")
			return
		}

		// Invalidate the device cache so the revoked device gets 403 immediately
		cache.invalidate(deviceKey)

		w.WriteHeader(http.StatusOK)
	}
}

// GET /v1/resolve/{handle}
func handleResolve(store Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		handle := r.PathValue("handle")
		if handle == "" {
			writeError(w, errBadRequest)
			return
		}

		handleData, err := store.GetObject(r.Context(), keyHandle(handle))
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeError(w, errNotFound)
				return
			}
			internalError(w, "Failed to read handle")
			return
		}

		var h publicHandleData
		json.Unmarshal(handleData, &h)

		// Fallback: if the handle projection predates a field (e.g. an
		// older projection without the v2 credential params), backfill
		// from profile.json so the login fork still gets salt + kdf.
		if h.SharingPublicKey == "" || (h.Salt == "" && h.KDF == nil) {
			if p, err := getProfile(r.Context(), store, h.UserID); err == nil {
				if h.SharingPublicKey == "" {
					h.SharingPublicKey = p.SharingPublicKey
				}
				if h.Salt == "" && h.KDF == nil {
					h.Salt = p.Salt
					h.KDF = p.KDF
					h.KeyVersion = p.KeyVersion
				}
			}
		}

		writeJSON(w, http.StatusOK, h)
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
		p, err := getProfile(r.Context(), store, userID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeError(w, errNotFound)
				return
			}
			internalError(w, "Failed to read profile")
			return
		}

		if req.DisplayName != nil {
			p.DisplayName = *req.DisplayName
		}
		if req.AvatarURL != nil {
			p.AvatarURL = *req.AvatarURL
		}

		if err := putProfile(r.Context(), store, p); err != nil {
			internalError(w, "Failed to write profile")
			return
		}

		// Project public fields to handle file
		putHandleProjection(r.Context(), store, p)

		w.WriteHeader(http.StatusOK)
	}
}

// DELETE /v1/profile
func handleDeleteProfile(store Store) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())

		// Read profile to get handle
		p, err := getProfile(r.Context(), store, userID)
		if err != nil {
			if errors.Is(err, ErrNotFound) {
				writeError(w, errNotFound)
				return
			}
			internalError(w, "Failed to read profile")
			return
		}

		// Delete all objects under each prefix
		for _, prefix := range []string{
			prefixUser(userID),
			prefixInbox(userID),
			prefixKeys(userID),
			prefixMedia(userID),
		} {
			keys, _, err := store.ListObjects(r.Context(), prefix, 1000, "")
			if err != nil {
				internalError(w, "Failed to list objects")
				return
			}
			if len(keys) > 0 {
				if err := store.DeleteObjects(r.Context(), keys); err != nil {
					internalError(w, "Failed to delete objects")
					return
				}
			}
		}

		// Delete handle file
		if p.Handle != "" {
			store.DeleteObject(r.Context(), keyHandle(p.Handle))
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

			key := keyInboxLive(env.ToUser, env.MsgID)
			if err := store.PutObject(r.Context(), key, raw, "application/json"); err != nil {
				internalError(w, "Failed to write envelope")
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
func authorizePrefix(userID, prefix string) bool {
	for _, p := range dataPrefixes {
		if strings.HasPrefix(prefix, p+userID+"/") {
			return true
		}
	}
	// Also allow reading other users' profiles (for resolve/key fetch)
	if strings.HasPrefix(prefix, usersRoot) {
		return true
	}
	return false
}

func authorizeKey(userID, key string) bool {
	for _, p := range dataPrefixes {
		if strings.HasPrefix(key, p+userID+"/") {
			return true
		}
	}
	if strings.HasPrefix(key, usersRoot) {
		return true
	}
	// Media blobs are capability-protected: any authenticated user who
	// knows the ULID path (delivered via the encrypted envelope) may GET.
	// Write path (authorizeKeyWrite) remains restricted to the owner.
	if strings.HasPrefix(key, "media/") {
		return true
	}
	return false
}

// authorizeKeyWrite is like authorizeKey but restricts users/ to own uid only.
func authorizeKeyWrite(userID, key string) bool {
	for _, p := range dataPrefixes {
		if strings.HasPrefix(key, p+userID+"/") {
			return true
		}
	}
	if strings.HasPrefix(key, prefixUser(userID)) {
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
			internalError(w, "List failed")
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
			internalError(w, "Get failed")
			return
		}

		if strings.HasPrefix(key, "media/") {
			// `public` is required for browsers to cache responses to
			// requests carrying an `Authorization` header (RFC 9111 §3.5).
			// The bytes are GCM-sealed ciphertext, so shared caching is safe.
			w.Header().Set("Cache-Control", "public, immutable, max-age=31536000")
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(data)
	}
}

// POST /v1/store/presign
func handleStorePresign(store Store, quota MediaQuotaStore) http.HandlerFunc {
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
		if strings.HasPrefix(req.Key, "media/") {
			if req.Bytes > MAX_MEDIA_BYTES {
				writeError(w, errTooLarge)
				return
			}
			ok, _, err := quota.ReserveUpload(r.Context(), userID, req.Bytes)
			if err != nil {
				internalError(w, "Quota check failed")
				return
			}
			if !ok {
				writeError(w, errQuotaExceeded)
				return
			}
		}

		url, err := store.PresignPut(r.Context(), req.Key, req.Bytes, 15*time.Minute)
		if err != nil {
			internalError(w, "Presign failed")
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
		boundary := req.Prefix + req.UpTo
		var toCompact []string
		cursor := ""
		for {
			keys, nextCursor, err := store.ListObjects(r.Context(), req.Prefix, 100, cursor)
			if err != nil {
				internalError(w, "List failed")
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
				internalError(w, "Read failed")
				return
			}
			var obj any
			if err := json.Unmarshal(data, &obj); err != nil {
				internalError(w, "Decode failed")
				return
			}
			newObjects = append(newObjects, obj)
		}

		// Find existing same-day archives to merge with.
		// Archive prefix is sibling of live/: inbox/{uid}/live/ → inbox/{uid}/archive/
		today := time.Now().UTC().Format("2006-01-02")
		archivePrefixBase := strings.TrimSuffix(req.Prefix, "live/") + "archive/"
		archivePrefix := archivePrefixBase + today
		var existingArchiveKeys []string
		cursor = ""
		for {
			keys, nextCursor, err := store.ListObjects(r.Context(), archivePrefix, 100, cursor)
			if err != nil {
				internalError(w, "List archives failed")
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
				internalError(w, "Read archive failed")
				return
			}
			var objs []any
			if err := cbor.Unmarshal(data, &objs); err != nil {
				internalError(w, "CBOR decode failed")
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
			internalError(w, "CBOR encode failed")
			return
		}

		// Write archive with ULID suffix for uniqueness.
		// No object is deleted before the new archive is durably written.
		archiveKey := archivePrefixBase + today + "-" + ulid.Make().String()
		if err := store.PutObject(r.Context(), archiveKey, archive, "application/cbor"); err != nil {
			internalError(w, "Write archive failed")
			return
		}

		// Delete compacted live objects and old archives.
		toDelete := append(toCompact, existingArchiveKeys...)
		if err := store.DeleteObjects(r.Context(), toDelete); err != nil {
			internalError(w, "Delete failed")
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
