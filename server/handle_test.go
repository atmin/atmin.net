package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestValidateHandle_Accepts(t *testing.T) {
	cases := []string{
		"alice",
		"alice-test",
		"copper-falcon",                    // legacy auto-generated shape
		"abc",                              // minimum length
		"a-b",                              // hyphen surrounded by letters
		"alice2",                           // digit at end
		"alice-2024",                       // digits after hyphen
		"abcdefghij1234567890123456789012", // 32 chars exactly
	}
	for _, h := range cases {
		t.Run(h, func(t *testing.T) {
			if err := validateHandle(h); err != nil {
				t.Fatalf("validateHandle(%q) = %v, want nil", h, err)
			}
		})
	}
}

func TestValidateHandle_Rejects(t *testing.T) {
	cases := []struct {
		handle string
		want   APIError
	}{
		{"ab", errHandleInvalid},                                // too short
		{"a", errHandleInvalid},                                 // way too short
		{"", errHandleInvalid},                                  // empty
		{"abcdefghij1234567890123456789012x", errHandleInvalid}, // 33 chars
		{"Alice", errHandleInvalid},                             // uppercase
		{"al ice", errHandleInvalid},                            // space
		{"alice_test", errHandleInvalid},                        // underscore
		{"alice--bot", errHandleInvalid},                        // consecutive hyphens
		{"-alice", errHandleInvalid},                            // leading hyphen
		{"alice-", errHandleInvalid},                            // trailing hyphen
		{"1alice", errHandleInvalid},                            // starts with digit
		{"alice.test", errHandleInvalid},                        // period
		{"alice@home", errHandleInvalid},                        // @
	}
	for _, tc := range cases {
		t.Run(tc.handle, func(t *testing.T) {
			err := validateHandle(tc.handle)
			var got APIError
			if !errors.As(err, &got) {
				t.Fatalf("validateHandle(%q) = %v, want APIError", tc.handle, err)
			}
			if got.Code != tc.want.Code {
				t.Fatalf("validateHandle(%q) code = %q, want %q", tc.handle, got.Code, tc.want.Code)
			}
		})
	}
}

func TestValidateHandle_ReservedList(t *testing.T) {
	// Every entry in the embedded list must reject with the reserved code.
	if len(reservedHandles) == 0 {
		t.Fatal("reservedHandles is empty — embed didn't load")
	}
	for h := range reservedHandles {
		t.Run(h, func(t *testing.T) {
			err := validateHandle(h)
			var got APIError
			if !errors.As(err, &got) {
				t.Fatalf("validateHandle(%q) = %v, want APIError", h, err)
			}
			if got.Code != errHandleReserved.Code {
				t.Fatalf("validateHandle(%q) code = %q, want %q", h, got.Code, errHandleReserved.Code)
			}
		})
	}
}

func TestParseReservedHandles_FileFormat(t *testing.T) {
	// Pins the file-format contract so an operator-edited file behaves
	// predictably: comments, blank lines, whitespace, mixed case.
	raw := `# top comment
admin
  root
ATMIN

# blank line and trailing whitespace above
mixedCASE
`
	got := parseReservedHandles(raw)
	want := map[string]bool{
		"admin":     true,
		"root":      true,
		"atmin":     true,
		"mixedcase": true,
	}
	if len(got) != len(want) {
		t.Fatalf("parseReservedHandles: %d entries, want %d (got %+v)", len(got), len(want), got)
	}
	for h := range want {
		if !got[h] {
			t.Fatalf("missing %q in %+v", h, got)
		}
	}
}

func TestParseReservedHandles_EmptyInput(t *testing.T) {
	if got := parseReservedHandles(""); len(got) != 0 {
		t.Fatalf("empty input: got %+v, want empty", got)
	}
	if got := parseReservedHandles("\n\n# only comments\n\n"); len(got) != 0 {
		t.Fatalf("only-comments input: got %+v, want empty", got)
	}
}

// The override path (RESERVED_HANDLES_PATH) is read at init time so we
// can't easily exercise the env-var branch in a unit test without
// re-invoking init. Instead we test the parser directly (above) and
// verify the override-file-read code path via parseReservedHandles on
// the raw contents.
func TestReservedHandles_OverrideFileShape(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "reserved.txt")
	if err := os.WriteFile(path, []byte("custom-name\n# comment\n   another  \n"), 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	got := parseReservedHandles(string(data))
	if !got["custom-name"] || !got["another"] {
		t.Fatalf("expected custom-name + another in %+v", got)
	}
	if got["# comment"] {
		t.Fatal("comment line leaked into reserved set")
	}
}
