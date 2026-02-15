package main

import "net/http"

func newMux(store Store, cfg Config, hub *EventHub) http.Handler {
	mux := http.NewServeMux()

	// Health check
	mux.HandleFunc("GET /healthz", handleHealthz)

	// Public endpoints
	mux.HandleFunc("POST /v1/register", handleRegister(store, cfg))
	mux.HandleFunc("GET /v1/resolve/{invite_handle}", handleResolve(store))
	mux.HandleFunc("POST /v1/devices", handleAddDevice(store, cfg))

	// Authenticated endpoints
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return requireAuth(h, store, cfg)
	}
	mux.HandleFunc("PUT /v1/profile", auth(handleProfile(store)))
	mux.HandleFunc("POST /v1/devices/revoke", auth(handleRevokeDevice(store, cfg)))
	mux.HandleFunc("POST /v1/send", auth(handleSend(store, hub)))
	mux.HandleFunc("GET /v1/events", auth(handleEvents(hub)))
	mux.HandleFunc("GET /v1/store/list", auth(handleStoreList(store)))
	mux.HandleFunc("GET /v1/store/object", auth(handleStoreObject(store)))
	mux.HandleFunc("POST /v1/store/presign", auth(handleStorePresign(store)))
	mux.HandleFunc("POST /v1/store/compact", auth(handleStoreCompact(store)))

	// Static web app (catch-all, lowest priority)
	mux.Handle("GET /", serveStatic())

	return logRequests(mux)
}
