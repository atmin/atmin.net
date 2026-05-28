package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"time"

	"github.com/fxamacker/cbor/v2"
	"github.com/gowebpki/jcs"
	"github.com/oklog/ulid/v2"
)

func handleHealthz(w http.ResponseWriter, r *http.Request) {
	w.WriteHeader(http.StatusOK)
	w.Write([]byte("ok"))
}

// POST /v1/register
//
// The client picks the handle (ADR-0013); the server validates, takes the
// per-handle mutex, claims atomically against an optional cooldown
// tombstone, then writes profile + device + handle projection. On any
// write failure after the handle has been claimed, the handle projection
// is best-effort cleaned up so the namespace doesn't leak.
func handleRegister(store Store, cfg Config, handleMu *handleMutexMap) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			Handle           string     `json:"handle"`
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
		if req.Handle == "" || req.DeviceLabel == "" || req.AuthPublicKey == "" || req.SharingPublicKey == "" {
			writeError(w, errBadRequest)
			return
		}

		// Handle validation: charset / length first (cheap), then reserved
		// list (also cheap, but with distinct error code for the client).
		if err := validateHandle(req.Handle); err != nil {
			writeError(w, err.(APIError))
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

		// Atomically claim the handle. The mutex serialises against any
		// concurrent registration of the same handle on this instance.
		release, err := handleMu.acquire(req.Handle, 500*time.Millisecond)
		if err != nil {
			writeError(w, errRegistrationUnavailable)
			return
		}
		defer release()

		// GET-then-PUT inside the mutex. Three branches on the GET:
		//
		//   - 404 → handle is free, proceed.
		//   - 200 live projection → 409 handle_taken.
		//   - 200 tombstone with released_at in the future → 409 handle_in_cooldown.
		//   - 200 tombstone with released_at in the past → stale tombstone,
		//     delete it and proceed.
		existing, getErr := store.GetObject(r.Context(), keyHandle(req.Handle))
		if getErr != nil && !errors.Is(getErr, ErrNotFound) {
			internalError(w, "Failed to read handle")
			return
		}
		if getErr == nil {
			var h publicHandleData
			if err := json.Unmarshal(existing, &h); err != nil {
				internalError(w, "Failed to parse handle projection")
				return
			}
			if h.ReleasedAt != "" {
				releasedAt, parseErr := time.Parse(time.RFC3339, h.ReleasedAt)
				if parseErr != nil {
					// Corrupt tombstone — treat as live to be safe; an
					// operator can investigate the offending key.
					writeError(w, errHandleTaken)
					return
				}
				availableAt := releasedAt.Add(handleCooldown)
				if time.Now().UTC().Before(availableAt) {
					writeErrorStatus(w, errHandleInCooldown, http.StatusConflict, map[string]any{
						"released_at":  h.ReleasedAt,
						"available_at": availableAt.UTC().Format(time.RFC3339),
					})
					return
				}
				// Stale tombstone: cleanup hasn't gotten here yet. Delete
				// in-band so the unconditional PUT below replaces it cleanly.
				if err := store.DeleteObject(r.Context(), keyHandle(req.Handle)); err != nil && !errors.Is(err, ErrNotFound) {
					internalError(w, "Failed to clear stale tombstone")
					return
				}
			} else {
				writeError(w, errHandleTaken)
				return
			}
		}

		userID := ulid.Make().String()
		deviceID := ulid.Make().String()
		// New accounts always start at key_version 1; the token is v2-format
		// even for v1 (no-salt/kdf) registrations — only the profile shape
		// differs between v1 and v2 there.
		token := generateToken(cfg.ServerSecret, userID, deviceID, 1)

		p := &Profile{
			UserID:           userID,
			Handle:           req.Handle,
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

		// Order: handle projection FIRST (claims the name under the mutex),
		// then profile + device. If a later write fails, best-effort delete
		// the projection so the handle returns to the free pool. The
		// user_id was never returned, so its abandonment is invisible.
		if err := putHandleProjection(r.Context(), store, p); err != nil {
			internalError(w, "Failed to write handle")
			return
		}
		if err := putProfile(r.Context(), store, p); err != nil {
			// Best-effort cleanup; if even the delete fails the cleanup
			// routine will sweep this orphan (handle pointing at a missing
			// profile) on its next pass.
			store.DeleteObject(r.Context(), keyHandle(req.Handle))
			internalError(w, "Failed to write profile")
			return
		}
		device, _ := json.Marshal(map[string]string{
			"device_id":    deviceID,
			"device_label": req.DeviceLabel,
			"created_at":   time.Now().UTC().Format(time.RFC3339),
		})
		if err := store.PutObject(r.Context(), keyDevice(userID, deviceID), device, "application/json"); err != nil {
			store.DeleteObject(r.Context(), keyHandle(req.Handle))
			store.DeleteObject(r.Context(), keyProfile(userID))
			internalError(w, "Failed to write device")
			return
		}

		writeJSON(w, http.StatusOK, map[string]string{
			"user_id":   userID,
			"device_id": deviceID,
			"token":     token,
			"handle":    req.Handle,
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

// Sentinel errors for fetchAndVerifyAuthProof. The profile is also returned
// on stale-version failures so the caller can render the current kv to the
// client without a second S3 read.
var (
	errAuthProofInvalid = errors.New("auth proof invalid")
	errAuthProofStale   = errors.New("auth proof key_version stale")
)

// fetchAndVerifyAuthProof fetches the user's profile to get their auth public
// key, verifies the auth-proof signature, and (for v2 payloads) confirms the
// proof's key_version matches the current profile.key_version. Returns the
// profile on success and on staleness; returns nil on ErrNotFound / invalid.
func fetchAndVerifyAuthProof(ctx context.Context, store Store, userID string, proof AuthProof) (*Profile, error) {
	p, err := getProfile(ctx, store, userID)
	if err != nil {
		return nil, err
	}
	pubKeyBytes, err := b64url.DecodeString(p.AuthPublicKey)
	if err != nil || len(pubKeyBytes) != ed25519.PublicKeySize {
		return nil, errAuthProofInvalid
	}
	if err := verifyAuthProof(ed25519.PublicKey(pubKeyBytes), proof); err != nil {
		return nil, errAuthProofInvalid
	}
	// v2 proofs are only valid against the current key_version. v1 proofs
	// (no key_version field) ride implicit kv=1, which is correct for any
	// account that hasn't rotated.
	if proof.Payload.KeyVersion > 0 {
		currentKV := p.KeyVersion
		if currentKV == 0 {
			currentKV = 1
		}
		if proof.Payload.KeyVersion != currentKV {
			return p, errAuthProofStale
		}
	}
	return p, nil
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

		p, err := fetchAndVerifyAuthProof(r.Context(), store, req.UserID, req.AuthProof)
		if err != nil {
			switch {
			case errors.Is(err, ErrNotFound):
				writeError(w, errNotFound)
			case errors.Is(err, errAuthProofStale):
				currentKV := p.KeyVersion
				if currentKV == 0 {
					currentKV = 1
				}
				writeErrorStatus(w, errKeyVersionStale, http.StatusUnauthorized, map[string]any{"current": currentKV})
			case errors.Is(err, errAuthProofInvalid):
				writeError(w, errForbidden)
			default:
				internalError(w, "Failed to verify auth proof")
			}
			return
		}

		deviceID := req.AuthProof.Payload.DeviceID
		// New token is bound to the account's current key_version (v1 accounts
		// ride implicit kv=1; rotated v2 accounts mint at their current kv).
		kv := p.KeyVersion
		if kv == 0 {
			kv = 1
		}
		token := generateToken(cfg.ServerSecret, req.UserID, deviceID, kv)

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

		p, err := fetchAndVerifyAuthProof(r.Context(), store, userID, req.AuthProof)
		if err != nil {
			switch {
			case errors.Is(err, errAuthProofStale):
				currentKV := p.KeyVersion
				if currentKV == 0 {
					currentKV = 1
				}
				writeErrorStatus(w, errKeyVersionStale, http.StatusUnauthorized, map[string]any{"current": currentKV})
			case errors.Is(err, errAuthProofInvalid):
				writeError(w, errForbidden)
			default:
				internalError(w, "Failed to verify auth proof")
			}
			return
		}
		_ = p // profile fetch is reused to short-circuit; no further use here

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
//
// Three outcomes:
//   - 200 with the live projection (handle is currently registered).
//   - 410 Gone with { released_at, available_at } when the handle is in
//     post-deletion cooldown — distinguishable from 404 so clients can
//     render "deleted, available on YYYY-MM-DD".
//   - 404 for both never-registered and stale tombstones (cleanup
//     routine hasn't swept yet but the handle is logically free).
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
		if err := json.Unmarshal(handleData, &h); err != nil {
			internalError(w, "Failed to parse handle projection")
			return
		}

		if h.ReleasedAt != "" {
			releasedAt, parseErr := time.Parse(time.RFC3339, h.ReleasedAt)
			if parseErr != nil {
				// Corrupt tombstone — surface a 404 rather than leak the
				// malformed value to clients.
				writeError(w, errNotFound)
				return
			}
			availableAt := releasedAt.Add(handleCooldown)
			if time.Now().UTC().Before(availableAt) {
				writeErrorStatus(w, errHandleReleased, http.StatusGone, map[string]any{
					"released_at":  h.ReleasedAt,
					"available_at": availableAt.UTC().Format(time.RFC3339),
				})
				return
			}
			// Stale tombstone: cooldown elapsed, cleanup pending. Logically
			// free → 404.
			writeError(w, errNotFound)
			return
		}

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
//
// Replaces the handle projection with a tombstone (ADR-0013) so the
// handle remains reserved for 30 days. Acquires the per-handle mutex to
// serialise against any in-flight registration of the same handle —
// rare, but possible if the deletion races a takeover attempt.
func handleDeleteProfile(store Store, handleMu *handleMutexMap) http.HandlerFunc {
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

		// Rewrite the handle as a tombstone so it stays reserved for the
		// cooldown window. The mutex acquisition serialises against any
		// in-flight registration on the same handle.
		if p.Handle != "" {
			release, err := handleMu.acquire(p.Handle, 500*time.Millisecond)
			if err != nil {
				// Contended: registration is racing the delete. The
				// account contents are already gone; surface 503 so the
				// caller can retry the delete to install the tombstone.
				writeError(w, errRegistrationUnavailable)
				return
			}
			tombstone := publicHandleData{
				ReleasedAt: time.Now().UTC().Format(time.RFC3339),
			}
			data, _ := json.Marshal(tombstone)
			err = store.PutObject(r.Context(), keyHandle(p.Handle), data, "application/json")
			release()
			if err != nil {
				internalError(w, "Failed to write handle tombstone")
				return
			}
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

// ── POST /v1/rotate-keys ─────────────────────────────────────────────
//
// See ADR-0012 + docs/specs/mvp-v0.1.md#rotate-keys. The bearer token's
// key_version match is already enforced by requireAuth — only a device
// holding a current-kv token reaches this handler. Per-user_id mutex
// serializes the GET-VERIFY-WRITE on profile.json against a concurrent
// rotation; request_id deduplicates network retries.

var requestIDRegex = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

type rotateKeysRequest struct {
	RequestID           string     `json:"request_id"`
	KeyVersion          int        `json:"key_version"`
	AuthPublicKey       string     `json:"auth_public_key"`
	SharingPublicKey    string     `json:"sharing_public_key"`
	Salt                string     `json:"salt"`
	KDF                 *KDFParams `json:"kdf"`
	ContinuitySignature string     `json:"continuity_signature"`
}

// rotationMutexTimeout caps how long a rotation handler waits for the
// per-uid lock before returning 409. Two genuinely-concurrent rotations
// from the same user are degenerate; 500 ms is plenty of headroom for
// the in-flight one to complete an S3 write and release.
const rotationMutexTimeout = 500 * time.Millisecond

func handleRotateKeys(store Store, cfg Config, profCache *profileCache, mu *rotationMutexMap) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := userIDFrom(r.Context())
		deviceID := deviceIDFrom(r.Context())

		var req rotateKeysRequest
		if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
			writeError(w, errBadRequest)
			return
		}
		if !requestIDRegex.MatchString(req.RequestID) {
			writeError(w, errBadRequest)
			return
		}
		// Validate the new credential params up front so a malformed
		// rotation never reaches the mutex/profile write.
		if req.Salt == "" || req.KDF == nil || !validKDFParams(req.Salt, req.KDF) {
			writeError(w, errBadRequest)
			return
		}
		if !validPublicKey(req.AuthPublicKey, ed25519.PublicKeySize) ||
			!validPublicKey(req.SharingPublicKey, 65) {
			writeError(w, errBadRequest)
			return
		}
		if req.ContinuitySignature == "" {
			writeError(w, errBadRequest)
			return
		}

		// 1. Serialize per user_id. Concurrent rotations from the same
		// user fall through to the idempotency check or the kv
		// precondition; this just prevents the GET-VERIFY-WRITE race.
		release, err := mu.acquire(userID, rotationMutexTimeout)
		if err != nil {
			// Genuine concurrent rotation against ourselves. Single-instance:
			// 409 with current=-1 (the other writer hasn't finished, so we
			// can't yet quote a current kv). Multi-instance future: 503.
			writeErrorStatus(w, errKeyVersionStale, http.StatusConflict, map[string]any{"current": -1})
			return
		}
		defer release()

		// 2. Idempotency: replay if seen.
		if rec, ok, _ := loadRotationRecord(r.Context(), store, userID, req.RequestID); ok {
			writeJSON(w, rec.Status, rec.Body())
			return
		}

		// 3. Read current profile.
		current, err := getProfile(r.Context(), store, userID)
		if err != nil {
			internalError(w, "Failed to read profile")
			return
		}
		currentKV := current.KeyVersion
		if currentKV == 0 {
			currentKV = 1
		}

		// 4. key_version precondition: request must advance by exactly one.
		if req.KeyVersion != currentKV+1 {
			rec := RotationRecord{
				Status:  http.StatusConflict,
				Error:   errKeyVersionStale.Code,
				Current: currentKV,
			}
			_ = saveRotationRecord(r.Context(), store, userID, req.RequestID, rec)
			writeErrorStatus(w, errKeyVersionStale, http.StatusConflict, map[string]any{"current": currentKV})
			return
		}

		// 5. Continuity signature over JCS-canonicalized body sans sig.
		canonical, err := canonicalRotationBody(&req)
		if err != nil {
			internalError(w, "Failed to canonicalize rotation body")
			return
		}
		oldPub, err := b64url.DecodeString(current.AuthPublicKey)
		if err != nil || len(oldPub) != ed25519.PublicKeySize {
			internalError(w, "Stored auth_public_key is malformed")
			return
		}
		sigBytes, err := b64url.DecodeString(req.ContinuitySignature)
		if err != nil || !ed25519.Verify(ed25519.PublicKey(oldPub), canonical, sigBytes) {
			rec := RotationRecord{Status: http.StatusForbidden, Error: errBadContinuity.Code}
			_ = saveRotationRecord(r.Context(), store, userID, req.RequestID, rec)
			writeError(w, errBadContinuity)
			return
		}

		// 6. Build & write new profile (unconditional; mutex makes the
		// GET-VERIFY-WRITE effectively atomic for this uid).
		next := *current
		next.AuthPublicKey = req.AuthPublicKey
		next.SharingPublicKey = req.SharingPublicKey
		next.Salt = req.Salt
		next.KDF = req.KDF
		next.KeyVersion = req.KeyVersion
		if err := putProfile(r.Context(), store, &next); err != nil {
			internalError(w, "Failed to write profile")
			return
		}

		// 7. Refresh the resolve projection so other users see the new
		// sharing_public_key + salt/kdf on their next resolve.
		if err := putHandleProjection(r.Context(), store, &next); err != nil {
			slog.Error("rotate: handle projection write failed", "user_id", userID, "err", err)
			// Profile is already authoritative; resolve will fall back to it.
		}

		// 8. Mint a new v2 token bound to the new key_version.
		token := generateToken(cfg.ServerSecret, userID, deviceID, req.KeyVersion)

		// 9. Record the outcome under the request_id for idempotent replay.
		rec := RotationRecord{
			Status:     http.StatusOK,
			Token:      token,
			KeyVersion: req.KeyVersion,
		}
		if err := saveRotationRecord(r.Context(), store, userID, req.RequestID, rec); err != nil {
			// Best-effort: the rotation already succeeded. A retry would
			// hit the kv precondition and 409, which is acceptable.
			slog.Error("rotate: save idempotency record failed", "user_id", userID, "err", err)
		}

		// 10. Invalidate the local profile cache so the next requireAuth
		// fetch reflects the new kv without waiting for TTL expiry.
		profCache.invalidate(userID)

		writeJSON(w, http.StatusOK, map[string]any{
			"token":       token,
			"key_version": req.KeyVersion,
		})
	}
}

// canonicalRotationBody marshals the rotation request's signed fields
// (everything except continuity_signature) and runs them through JCS so
// the bytes match what the client signed. Both sides depend on this
// agreement — the JCS interop fixture is the regression guard.
func canonicalRotationBody(req *rotateKeysRequest) ([]byte, error) {
	toSign := map[string]any{
		"request_id":         req.RequestID,
		"key_version":        req.KeyVersion,
		"auth_public_key":    req.AuthPublicKey,
		"sharing_public_key": req.SharingPublicKey,
		"salt":               req.Salt,
		"kdf":                req.KDF,
	}
	raw, err := json.Marshal(toSign)
	if err != nil {
		return nil, err
	}
	return jcs.Transform(raw)
}

func validPublicKey(b64 string, wantLen int) bool {
	if b64 == "" {
		return false
	}
	b, err := b64url.DecodeString(b64)
	if err != nil || len(b) != wantLen {
		return false
	}
	return true
}
