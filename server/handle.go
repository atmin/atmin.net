package main

import (
	_ "embed"
	"os"
	"regexp"
	"strings"
)

//go:embed reserved_handles.txt
var reservedHandlesEmbed string

// reservedHandles is the set of names disallowed as user handles (ADR-0013).
// Initialised at package init from the embedded file, overridable via the
// RESERVED_HANDLES_PATH env var for operator control without a rebuild.
var reservedHandles map[string]bool

// handleRegex pins the user-handle charset and length:
//
//   - lowercase ASCII letters, digits, hyphens only
//   - 3..32 characters total (interior {1,30} + first + last = 32 max)
//   - first character must be a letter (forbids "01abc")
//   - last character may not be a hyphen
//
// "No consecutive hyphens" is checked separately because Go's regexp
// engine is RE2 and cannot express a forward-looking constraint.
var handleRegex = regexp.MustCompile(`^[a-z][a-z0-9-]{1,30}[a-z0-9]$`)

func init() {
	raw := reservedHandlesEmbed
	if override := os.Getenv("RESERVED_HANDLES_PATH"); override != "" {
		if data, err := os.ReadFile(override); err == nil {
			raw = string(data)
		}
		// Silent fallback to the embedded list on read failure: a missing
		// override file shouldn't prevent the server from booting.
	}
	reservedHandles = parseReservedHandles(raw)
}

// parseReservedHandles applies the file-format rules pinned by tests:
//
//   - trim whitespace
//   - skip empty lines
//   - skip lines starting with "#" (comments)
//   - lowercase entries (any uppercase is normalised, not rejected)
func parseReservedHandles(raw string) map[string]bool {
	out := map[string]bool{}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		out[strings.ToLower(line)] = true
	}
	return out
}

// validateHandle returns nil for a syntactically and policy-valid handle,
// errHandleInvalid for charset / length violations, or errHandleReserved
// for blocklist matches.
func validateHandle(h string) error {
	if !handleRegex.MatchString(h) {
		return errHandleInvalid
	}
	if strings.Contains(h, "--") {
		return errHandleInvalid
	}
	if reservedHandles[h] {
		return errHandleReserved
	}
	return nil
}
