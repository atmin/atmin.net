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
	errBadRequest    = APIError{http.StatusBadRequest, "bad_request", "Malformed input"}
	errUnauthorized  = APIError{http.StatusUnauthorized, "unauthorized", "Missing or invalid token"}
	errDeviceRevoked = APIError{http.StatusForbidden, "device_revoked", "Device has been revoked"}
	errForbidden     = APIError{http.StatusForbidden, "forbidden", "Access denied"}
	errNotFound      = APIError{http.StatusNotFound, "not_found", "Not found"}
	errQuotaExceeded = APIError{http.StatusRequestEntityTooLarge, "quota_exceeded", "Storage quota exceeded"}
	errTooLarge      = APIError{http.StatusRequestEntityTooLarge, "too_large", "Payload exceeds size limit"}
)

func internalError(w http.ResponseWriter, msg string) {
	writeError(w, APIError{http.StatusInternalServerError, "internal", msg})
}

func writeError(w http.ResponseWriter, err APIError) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(err.HTTPStatus)
	json.NewEncoder(w).Encode(err)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}
