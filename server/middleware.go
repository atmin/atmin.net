package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"strings"
	"sync"
	"time"
)

type contextKey string

const (
	ctxUserID   contextKey = "user_id"
	ctxDeviceID contextKey = "device_id"
)

func userIDFrom(ctx context.Context) string {
	return ctx.Value(ctxUserID).(string)
}

func deviceIDFrom(ctx context.Context) string {
	return ctx.Value(ctxDeviceID).(string)
}

// newDeviceCache creates a shared device cache for use across all auth handlers.
func newDeviceCache() *deviceCache {
	return &deviceCache{entries: make(map[string]time.Time)}
}

// requireAuth wraps a handler with token verification and device revocation check.
// Supports token from Authorization header (Bearer token) or query parameter (for SSE).
func requireAuth(next http.HandlerFunc, store Store, cfg Config, cache *deviceCache) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var token string

		// Try Authorization header first
		auth := r.Header.Get("Authorization")
		if strings.HasPrefix(auth, "Bearer ") {
			token = strings.TrimPrefix(auth, "Bearer ")
		} else {
			// Fall back to query parameter (for EventSource which can't set headers)
			token = r.URL.Query().Get("token")
		}

		if token == "" {
			writeError(w, errUnauthorized)
			return
		}

		userID, deviceID, err := parseToken(cfg.ServerSecret, token)
		if err != nil {
			writeError(w, errUnauthorized)
			return
		}

		// Revocation check: device file must exist
		deviceKey := "users/" + userID + "/devices/" + deviceID + ".json"
		if !cache.valid(deviceKey) {
			if err := store.HeadObject(r.Context(), deviceKey); err != nil {
				if errors.Is(err, ErrNotFound) {
					writeError(w, errDeviceRevoked)
					return
				}
				slog.Error("device check failed", "key", deviceKey, "err", err)
				writeError(w, APIError{http.StatusInternalServerError, "internal", "Device check failed"})
				return
			}
			cache.set(deviceKey)
		}

		ctx := context.WithValue(r.Context(), ctxUserID, userID)
		ctx = context.WithValue(ctx, ctxDeviceID, deviceID)
		next(w, r.WithContext(ctx))
	}
}

// deviceCache is a simple TTL cache for device existence checks.
type deviceCache struct {
	mu      sync.RWMutex
	entries map[string]time.Time
}

const deviceCacheTTL = 30 * time.Second

func (c *deviceCache) valid(key string) bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	t, ok := c.entries[key]
	return ok && time.Since(t) < deviceCacheTTL
}

func (c *deviceCache) set(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[key] = time.Now()
}

func (c *deviceCache) invalidate(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
}

// logRequests logs method, path, status, and duration for each request.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)
		slog.Info("request",
			"method", r.Method,
			"path", r.URL.Path,
			"status", sw.status,
			"dur_ms", time.Since(start).Milliseconds(),
		)
	})
}

type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	w.status = code
	w.ResponseWriter.WriteHeader(code)
}

// Flush implements http.Flusher for SSE support
func (w *statusWriter) Flush() {
	if f, ok := w.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}
