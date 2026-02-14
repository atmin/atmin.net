package main

import (
	"embed"
	"io/fs"
	"log/slog"
	"net/http"
	"path"
	"strings"
)

//go:embed dist
var distFS embed.FS

// serveStatic serves the embedded web app for all non-API routes.
// Falls back to index.html for client-side routing (SPA).
func serveStatic() http.Handler {
	// Strip the "dist/" prefix from embedded paths
	stripped, err := fs.Sub(distFS, "dist")
	if err != nil {
		slog.Error("failed to create sub-filesystem for dist", "err", err)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "static assets unavailable", http.StatusInternalServerError)
		})
	}

	fileServer := http.FileServer(http.FS(stripped))

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Clean the path to prevent directory traversal
		cleanPath := path.Clean(r.URL.Path)

		// Check if file exists
		if _, err := stripped.Open(strings.TrimPrefix(cleanPath, "/")); err != nil {
			// File not found → serve index.html for client-side routing
			r.URL.Path = "/"
		}

		fileServer.ServeHTTP(w, r)
	})
}
