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

// requireAuth wraps a handler with token verification and device revocation check.
func requireAuth(next http.HandlerFunc, store Store, cfg Config) http.HandlerFunc {
	cache := &deviceCache{entries: make(map[string]time.Time)}

	return func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		if !strings.HasPrefix(auth, "Bearer ") {
			writeError(w, errUnauthorized)
			return
		}
		token := strings.TrimPrefix(auth, "Bearer ")

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
