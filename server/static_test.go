package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
)

func TestServeStatic_KnownAsset(t *testing.T) {
	fsys := fstest.MapFS{
		"index.html":     {Data: []byte(`<!DOCTYPE html><title>App</title>`)},
		"assets/main.js": {Data: []byte(`console.log("main")`)},
	}
	h := serveStaticFromFS(fsys)

	req := httptest.NewRequest("GET", "/assets/main.js", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	body, _ := io.ReadAll(w.Body)
	if !strings.Contains(string(body), "console.log") {
		t.Fatalf("body does not contain expected asset content: %s", body)
	}
}

func TestServeStatic_FallbackToIndex(t *testing.T) {
	const marker = "SPA_INDEX_MARKER"
	fsys := fstest.MapFS{
		"index.html": {Data: []byte(`<!DOCTYPE html>` + marker)},
	}
	h := serveStaticFromFS(fsys)

	req := httptest.NewRequest("GET", "/some/deep/route", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	body, _ := io.ReadAll(w.Body)
	if !strings.Contains(string(body), marker) {
		t.Fatalf("body does not contain index.html marker; got: %s", body)
	}
}

func TestServeStatic_NoTraversal(t *testing.T) {
	const marker = "INDEX_ONLY"
	fsys := fstest.MapFS{
		"index.html": {Data: []byte(marker)},
	}
	h := serveStaticFromFS(fsys)

	req := httptest.NewRequest("GET", "/../etc/passwd", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	body, _ := io.ReadAll(w.Body)
	if !strings.Contains(string(body), marker) {
		t.Fatalf("traversal path did not fall back to index.html; got: %s", body)
	}
}
