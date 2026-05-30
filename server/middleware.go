package main

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type contextKey string

const (
	ctxUserID     contextKey = "user_id"
	ctxDeviceID   contextKey = "device_id"
	ctxKeyVersion contextKey = "key_version"
)

func userIDFrom(ctx context.Context) string {
	return ctx.Value(ctxUserID).(string)
}

func deviceIDFrom(ctx context.Context) string {
	return ctx.Value(ctxDeviceID).(string)
}

func keyVersionFrom(ctx context.Context) int {
	v, _ := ctx.Value(ctxKeyVersion).(int)
	return v
}

// newDeviceCache creates a shared device cache for use across all auth handlers.
func newDeviceCache() *deviceCache {
	return &deviceCache{entries: make(map[string]time.Time)}
}

// newProfileCache caches the current profile.key_version per uid so the
// requireAuth middleware doesn't issue an S3 GET on every authenticated
// request. The rotation handler invalidates the entry locally on every
// successful rotation; the TTL is the safety net for the multi-instance
// case where another server rotated.
func newProfileCache() *profileCache {
	return &profileCache{entries: make(map[string]profileCacheEntry)}
}

// requireAuth wraps a handler with token verification, device revocation check,
// and (when enforceKeyVersion is true) key_version check against the current
// profile (ADR-0012). The kv check is the multi-device cutoff that makes
// stale tokens 401 on any normal endpoint; the rotate-keys endpoint
// intentionally opts out because its handler runs its own precondition on
// `req.key_version` and must remain reachable with the just-superseded
// token so an idempotent retry can replay the recorded outcome.
func requireAuth(next http.HandlerFunc, store Store, cfg Config, devCache *deviceCache, profCache *profileCache, enforceKeyVersion bool) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := remoteIP(r)
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
			slog.Warn("auth: missing token", "ip", ip, "path", r.URL.Path)
			writeError(w, errUnauthorized)
			return
		}

		userID, deviceID, tokenKV, err := parseToken(cfg.ServerSecret, token)
		if err != nil {
			slog.Warn("auth: invalid token", "ip", ip, "path", r.URL.Path)
			writeError(w, errUnauthorized)
			return
		}

		// Revocation check: device file must exist
		deviceKey := keyDevice(userID, deviceID)
		if !devCache.valid(deviceKey) {
			if err := store.HeadObject(r.Context(), deviceKey); err != nil {
				if errors.Is(err, ErrNotFound) {
					slog.Warn("auth: device revoked", "ip", ip, "user_id", userID, "device_id", deviceID)
					writeError(w, errDeviceRevoked)
					return
				}
				if clientGone(r.Context(), err) {
					return
				}
				slog.Error("device check failed", "key", deviceKey, "err", err)
				writeError(w, APIError{http.StatusInternalServerError, "internal", "Device check failed"})
				return
			}
			devCache.set(deviceKey)
		}

		// key_version check (ADR-0012). A token bound to a superseded
		// key_version means another device rotated; tell the client to
		// re-login at the current version.
		var currentKV int
		if enforceKeyVersion {
			c, ok := profCache.get(userID)
			if !ok {
				p, err := getProfile(r.Context(), store, userID)
				if err != nil {
					if errors.Is(err, ErrNotFound) {
						slog.Warn("auth: profile gone", "ip", ip, "user_id", userID)
						writeError(w, errUnauthorized)
						return
					}
					if clientGone(r.Context(), err) {
						return
					}
					slog.Error("profile load failed", "user_id", userID, "err", err)
					writeError(w, APIError{http.StatusInternalServerError, "internal", "Profile load failed"})
					return
				}
				c = p.KeyVersion
				if c == 0 {
					c = 1 // defensive; every profile now carries key_version >= 1
				}
				profCache.set(userID, c)
			}
			currentKV = c
			if tokenKV != currentKV {
				slog.Warn("auth: key_version stale", "ip", ip, "user_id", userID, "token_kv", tokenKV, "current_kv", currentKV)
				writeErrorStatus(w, errKeyVersionStale, http.StatusUnauthorized, map[string]any{"current": currentKV})
				return
			}
		}

		ctx := context.WithValue(r.Context(), ctxUserID, userID)
		ctx = context.WithValue(ctx, ctxDeviceID, deviceID)
		ctx = context.WithValue(ctx, ctxKeyVersion, currentKV)
		next(w, r.WithContext(ctx))
	}
}

// clientGone reports whether the request was aborted by the client (context
// canceled / deadline) rather than failing server-side. Such errors are normal
// teardown — e.g. an EventSource closing — so callers bail quietly instead of
// logging an error or answering 500.
func clientGone(ctx context.Context, err error) bool {
	return ctx.Err() != nil ||
		errors.Is(err, context.Canceled) ||
		errors.Is(err, context.DeadlineExceeded)
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

// profileCache caches the current key_version per uid. A small TTL plus an
// explicit invalidate on rotation keeps the requireAuth fast path free of
// S3 GETs without letting a rotated kv linger.
type profileCache struct {
	mu      sync.RWMutex
	entries map[string]profileCacheEntry
}

type profileCacheEntry struct {
	keyVersion int
	at         time.Time
}

const profileCacheTTL = 5 * time.Second

func (c *profileCache) get(uid string) (int, bool) {
	c.mu.RLock()
	defer c.mu.RUnlock()
	e, ok := c.entries[uid]
	if !ok || time.Since(e.at) >= profileCacheTTL {
		return 0, false
	}
	return e.keyVersion, true
}

func (c *profileCache) set(uid string, kv int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.entries[uid] = profileCacheEntry{keyVersion: kv, at: time.Now()}
}

func (c *profileCache) invalidate(uid string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, uid)
}

// remoteIP extracts the client IP from X-Forwarded-For (set by Scaleway's proxy) or RemoteAddr.
func remoteIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		if i := strings.Index(xff, ","); i != -1 {
			return strings.TrimSpace(xff[:i])
		}
		return strings.TrimSpace(xff)
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	return host
}

// logRequests logs method, path, status, duration, IP, and user ID for each request.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(sw, r)

		userID, _ := r.Context().Value(ctxUserID).(string)
		args := []any{
			"method", r.Method,
			"path", r.URL.Path,
			"status", sw.status,
			"dur_ms", time.Since(start).Milliseconds(),
			"ip", remoteIP(r),
		}
		if userID != "" {
			args = append(args, "user_id", userID)
		}
		if sw.status >= 500 {
			slog.Error("request", args...)
		} else {
			slog.Info("request", args...)
		}
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
