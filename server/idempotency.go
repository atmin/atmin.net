package main

import (
	"context"
	"encoding/json"
	"errors"
)

// RotationRecord is the persisted outcome of one POST /v1/rotate-keys
// request, keyed by the client-generated request_id. The rotation handler
// replays it verbatim on a retry so a network timeout doesn't turn a
// successful rotation into a key_version_stale on the second try
// (ADR-0012 — Idempotency).
//
// Success: status=200 with Token + KeyVersion.
// Failure: status=409/403 with Error + (for kv mismatches) Current.
//
// Records are swept by the cleanup routine after the 24 h TTL — see
// tasks/server-cleanup-routine.md for the sweep target.
type RotationRecord struct {
	Status     int    `json:"status"`
	Token      string `json:"token,omitempty"`
	KeyVersion int    `json:"key_version,omitempty"`
	Error      string `json:"error,omitempty"`
	Current    int    `json:"current,omitempty"`
}

// Body returns the response body to replay for this record. Success uses
// {token, key_version}; failure uses the standard error shape plus the
// `current` field for kv mismatches.
func (r *RotationRecord) Body() map[string]any {
	if r.Status >= 200 && r.Status < 300 {
		return map[string]any{
			"token":       r.Token,
			"key_version": r.KeyVersion,
		}
	}
	out := map[string]any{
		"error":   r.Error,
		"message": errMessageFor(r.Error),
	}
	if r.Current != 0 {
		out["current"] = r.Current
	}
	return out
}

// errMessageFor maps a recorded error code back to its canonical message.
// Keeps replay-vs-fresh-fail bodies identical.
func errMessageFor(code string) string {
	switch code {
	case errKeyVersionStale.Code:
		return errKeyVersionStale.Message
	case errBadContinuity.Code:
		return errBadContinuity.Message
	default:
		return ""
	}
}

func loadRotationRecord(ctx context.Context, store Store, uid, requestID string) (*RotationRecord, bool, error) {
	data, err := store.GetObject(ctx, keyRotationRecord(uid, requestID))
	if err != nil {
		if errors.Is(err, ErrNotFound) {
			return nil, false, nil
		}
		return nil, false, err
	}
	var rec RotationRecord
	if err := json.Unmarshal(data, &rec); err != nil {
		return nil, false, err
	}
	return &rec, true, nil
}

func saveRotationRecord(ctx context.Context, store Store, uid, requestID string, rec RotationRecord) error {
	body, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	return store.PutObject(ctx, keyRotationRecord(uid, requestID), body, "application/json")
}
