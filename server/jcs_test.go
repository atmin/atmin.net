package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/gowebpki/jcs"
)

// TestJCSRotationVector pins gowebpki/jcs against the shared fixture used by
// the client's canonicalize on the same input. If either side breaks RFC 8785
// conformance the two halves of the rotation flow would silently disagree on
// the signed bytes — every rotation would return 403 bad_continuity with no
// obvious locus. This fixture is the cheapest catch.
func TestJCSRotationVector(t *testing.T) {
	fixtureDir := filepath.Join("..", "web", "e2e", "fixtures")
	in, err := os.ReadFile(filepath.Join(fixtureDir, "jcs-rotation-vector.json"))
	if err != nil {
		t.Fatalf("read input fixture: %v", err)
	}
	want, err := os.ReadFile(filepath.Join(fixtureDir, "jcs-rotation-vector.canonical.txt"))
	if err != nil {
		t.Fatalf("read expected fixture: %v", err)
	}

	got, err := jcs.Transform(in)
	if err != nil {
		t.Fatalf("jcs.Transform: %v", err)
	}
	if string(got) != string(want) {
		t.Fatalf("canonical mismatch:\n got: %s\nwant: %s", got, want)
	}
}
