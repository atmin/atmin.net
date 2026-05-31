package main

import "net/http"

func newMux(store Store, cfg Config, hub *EventHub) http.Handler {
	mux := http.NewServeMux()

	// Health check
	mux.HandleFunc("GET /healthz", handleHealthz)

	// In-process coordination (single-instance — see ADR-0012, ADR-0013).
	handleMu := newHandleMutexMap()

	// Public endpoints
	mux.HandleFunc("POST /v1/register", handleRegister(store, cfg, handleMu))
	mux.HandleFunc("GET /v1/resolve/{handle}", handleResolve(store))
	mux.HandleFunc("POST /v1/devices", handleAddDevice(store, cfg))

	// Authenticated endpoints (shared device cache for instant revocation,
	// shared profile cache for the requireAuth key_version check).
	devCache := newDeviceCache()
	profCache := newProfileCache()
	rotationMu := newRotationMutexMap()
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return requireAuth(h, store, cfg, devCache, profCache, true)
	}
	// rotate-keys opts out of the middleware kv check (ADR-0012): a
	// just-superseded token must still reach the handler so idempotent
	// retries can replay the recorded outcome. The handler does its own
	// req.key_version vs current+1 precondition.
	authNoKV := func(h http.HandlerFunc) http.HandlerFunc {
		return requireAuth(h, store, cfg, devCache, profCache, false)
	}
	mux.HandleFunc("PUT /v1/profile", auth(handleProfile(store)))
	mux.HandleFunc("DELETE /v1/profile", auth(handleDeleteProfile(store, handleMu)))
	mux.HandleFunc("DELETE /v1/devices", auth(handleDeleteDevice(store, devCache)))
	mux.HandleFunc("POST /v1/devices/revoke", auth(handleRevokeDevice(store, cfg, devCache)))
	mux.HandleFunc("POST /v1/rotate-keys", authNoKV(handleRotateKeys(store, cfg, profCache, rotationMu)))
	mux.HandleFunc("POST /v1/send", auth(handleSend(store, hub)))
	mux.HandleFunc("GET /v1/events", auth(handleEvents(store, hub)))
	mux.HandleFunc("GET /v1/store/list", auth(handleStoreList(store)))
	// One shared quota instance across presign (reserve) and delete
	// (invalidate) so the delete path can expire the same cached usage.
	mediaQuota := NewMediaQuota(store)
	mux.HandleFunc("GET /v1/store/object", auth(handleStoreObject(store)))
	mux.HandleFunc("DELETE /v1/store/object", auth(handleDeleteObject(store, mediaQuota)))
	mux.HandleFunc("POST /v1/store/presign", auth(handleStorePresign(store, mediaQuota)))
	mux.HandleFunc("POST /v1/store/compact", auth(handleStoreCompact(store)))

	// Static web app (catch-all, lowest priority)
	mux.Handle("GET /", serveStatic())

	return logRequests(mux)
}
