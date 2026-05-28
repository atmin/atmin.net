package main

import (
	"encoding/json"
	"net/http"
)

type APIError struct {
	HTTPStatus int    `json:"-"`
	Code       string `json:"error"`
	Message    string `json:"message"`
}

func (e APIError) Error() string {
	return e.Message
}

var (
	errBadRequest              = APIError{http.StatusBadRequest, "bad_request", "Malformed input"}
	errUnauthorized            = APIError{http.StatusUnauthorized, "unauthorized", "Missing or invalid token"}
	errKeyVersionStale         = APIError{http.StatusUnauthorized, "key_version_stale", "Token or auth proof bound to a superseded key_version"}
	errDeviceRevoked           = APIError{http.StatusForbidden, "device_revoked", "Device has been revoked"}
	errBadContinuity           = APIError{http.StatusForbidden, "bad_continuity", "Continuity signature did not verify"}
	errForbidden               = APIError{http.StatusForbidden, "forbidden", "Access denied"}
	errNotFound                = APIError{http.StatusNotFound, "not_found", "Not found"}
	errHandleInvalid           = APIError{http.StatusBadRequest, "handle_invalid", "Handle does not match the required format"}
	errHandleReserved          = APIError{http.StatusBadRequest, "handle_reserved", "Handle is reserved"}
	errHandleTaken             = APIError{http.StatusConflict, "handle_taken", "Handle is already registered"}
	errHandleInCooldown        = APIError{http.StatusConflict, "handle_in_cooldown", "Handle is in 30-day cooldown after deletion"}
	errHandleReleased          = APIError{http.StatusGone, "released", "Handle was deleted; in cooldown"}
	errRegistrationUnavailable = APIError{http.StatusServiceUnavailable, "registration_unavailable", "Registration is temporarily unavailable for this handle"}
	errQuotaExceeded           = APIError{http.StatusRequestEntityTooLarge, "quota_exceeded", "Storage quota exceeded"}
	errTooLarge                = APIError{http.StatusRequestEntityTooLarge, "too_large", "Payload exceeds size limit"}
)

func internalError(w http.ResponseWriter, msg string) {
	writeError(w, APIError{http.StatusInternalServerError, "internal", msg})
}

func writeError(w http.ResponseWriter, err APIError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(err.HTTPStatus)
	json.NewEncoder(w).Encode(err)
}

// writeErrorStatus is writeError with a per-call status override and
// arbitrary extra fields merged into the body. Used for
// `key_version_stale`, which is 401 from the middleware (token mismatch)
// but 409 from rotate-keys (the request's key_version != current+1
// precondition); both shapes also carry `current` so the client knows
// what to render.
func writeErrorStatus(w http.ResponseWriter, err APIError, status int, extra map[string]any) {
	body := map[string]any{"error": err.Code, "message": err.Message}
	for k, v := range extra {
		body[k] = v
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(body)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
