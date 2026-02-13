package main

import "net/http"

func newMux(store Store, cfg Config) http.Handler {
	mux := http.NewServeMux()

	// Health check
	mux.HandleFunc("GET /healthz", handleHealthz)

	// Public endpoints
	mux.HandleFunc("POST /v1/register", handleRegister(store, cfg))
	mux.HandleFunc("GET /v1/resolve/{invite_handle}", handleResolve(store))

	// Authenticated endpoints
	auth := func(h http.HandlerFunc) http.HandlerFunc {
		return requireAuth(h, store, cfg)
	}
	mux.HandleFunc("POST /v1/devices", auth(handleAddDevice(store, cfg)))
	mux.HandleFunc("POST /v1/devices/revoke", auth(handleRevokeDevice(store, cfg)))
	mux.HandleFunc("POST /v1/send", auth(handleSend(store)))
	mux.HandleFunc("GET /v1/store/list", auth(handleStoreList(store)))
	mux.HandleFunc("GET /v1/store/object", auth(handleStoreObject(store)))
	mux.HandleFunc("POST /v1/store/presign", auth(handleStorePresign(store)))
	mux.HandleFunc("POST /v1/store/compact", auth(handleStoreCompact(store)))

	return logRequests(mux)
}
