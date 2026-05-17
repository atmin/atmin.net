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

func serveStatic() http.Handler {
	stripped, err := fs.Sub(distFS, "dist")
	if err != nil {
		slog.Error("failed to create sub-filesystem for dist", "err", err)
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			http.Error(w, "static assets unavailable", http.StatusInternalServerError)
		})
	}
	return serveStaticFromFS(stripped)
}

func serveStaticFromFS(fsys fs.FS) http.Handler {
	fileServer := http.FileServer(http.FS(fsys))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		cleanPath := path.Clean(r.URL.Path)
		if _, err := fsys.Open(strings.TrimPrefix(cleanPath, "/")); err != nil {
			r.URL.Path = "/"
		}
		fileServer.ServeHTTP(w, r)
	})
}
