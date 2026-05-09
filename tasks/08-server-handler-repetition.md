# Reduce repetition in server handlers — Profile struct + internalError helper

## Spec
None — refactor only. Behaviour and HTTP responses must be byte-identical (the existing handler_test.go suite is the regression net).

`docs/specs/mvp-v0.1.md` "Object schemas" defines the canonical `users/{uid}/profile.json` shape (this becomes the new struct's source of truth).

`docs/specs/mvp-v0.1.md` "Error responses" defines the canonical error shape. `server/error.go` already encodes the named errors.

## Current
Two repetitive patterns in `server/handlers.go`:

### 1. Profile read/parse pattern (open-coded ~5×)
- `handleResolve`: `GetObject(handles/...)` → `json.Unmarshal` into `map[string]string`, then string-keyed access (`handleObj["user_id"]`, `handleObj["sharing_public_key"]`, …). Plus a fallback path that loads `users/{uid}/profile.json` and reads `sharing_public_key` from it.
- `handleProfile` (PUT): `GetObject(profile)` → unmarshal into `map[string]string` → mutate → re-marshal → put back; then projects `display_name`/`avatar_url` to the `handles/` file.
- `handleDeleteProfile`: `GetObject(profile)` → unmarshal into `map[string]string` → read `handle`.
- `fetchAndVerifyAuthProof`: `GetObject(profile)` → unmarshal into a private struct with one field.
- `events.go` `updateLastActive`: `GetObject(profile)` → unmarshal into `map[string]string` → check `last_active` → mutate → re-marshal.
- `handleRegister`: marshals an inline `map[string]string` to write the initial profile.

Stringly-typed access loses type safety; every handler has its own slightly different parsing of the same blob.

### 2. Internal-error boilerplate (open-coded 14×)
```go
writeError(w, APIError{http.StatusInternalServerError, "internal", "Failed to read profile"})
```
appears almost verbatim across `handleRegister`, `handleAddDevice`, `handleDeleteDevice`, `handleRevokeDevice`, `handleResolve`, `handleProfile`, `handleDeleteProfile`, `handleSend`, `handleStoreList`, `handleStoreObject`, `handleStorePresign`, `handleStoreCompact`. Each call site re-states the long form.

## Change

### 8a. Profile struct + helpers
In `server/handlers.go` (or a new `server/profile.go`):

```go
type Profile struct {
    UserID           string `json:"user_id"`
    Handle           string `json:"handle"`
    AuthPublicKey    string `json:"auth_public_key"`
    SharingPublicKey string `json:"sharing_public_key"`
    DisplayName      string `json:"display_name,omitempty"`
    AvatarURL        string `json:"avatar_url,omitempty"`
    LastActive       string `json:"last_active,omitempty"`
    CreatedAt        string `json:"created_at"`
}

// getProfile reads users/{uid}/profile.json and unmarshals into Profile.
// Returns ErrNotFound if the profile does not exist.
func getProfile(ctx context.Context, store Store, uid string) (*Profile, error) { ... }

// putProfile writes the profile back. Round-trips json.Marshal → store.PutObject.
func putProfile(ctx context.Context, store Store, p *Profile) error { ... }

// publicHandleData is the projection written to handles/{handle}.json.
type publicHandleData struct {
    UserID           string `json:"user_id"`
    SharingPublicKey string `json:"sharing_public_key"`
    DisplayName      string `json:"display_name,omitempty"`
    AvatarURL        string `json:"avatar_url,omitempty"`
}

func putHandleProjection(ctx context.Context, store Store, p *Profile) error { ... }
```

Refactor `handleRegister`, `handleResolve` (load handle file then optionally Profile), `handleProfile`, `handleDeleteProfile`, `fetchAndVerifyAuthProof`, and `events.go` `updateLastActive` to use these helpers instead of `map[string]string`. Behaviour unchanged: same fields, same JSON encoding, same `omitempty` semantics (the resolve fallback that sniffs `sharing_public_key` from `profile.json` becomes a one-line `if h.SharingPublicKey == ""` check).

### 8b. internalError helper
In `server/error.go`:

```go
// internalError writes a 500 with the standard "internal" code and the given message.
// The message is user-facing and should be a short, present-tense description
// of what failed (e.g. "Failed to read profile"). Inspect server logs for details.
func internalError(w http.ResponseWriter, msg string) {
    writeError(w, APIError{http.StatusInternalServerError, "internal", msg})
}
```

Replace all 14 inline call sites in `handlers.go`. Optional: unify the message wording while you're there (e.g. always "Failed to <verb> <noun>" — the existing strings already follow this).

## Verify
- `cd server && go test ./...` passes — every existing test must continue to pass byte-identically (these tests verify HTTP status codes and response bodies; no fixture should need updating).
- `grep -n "APIError{http.StatusInternalServerError" server/*.go` returns only the helper definition in `error.go`.
- `grep -n "map\[string\]string" server/handlers.go server/events.go` returns only request-payload structs (`map[string]string{"user_id": ...}` in response shapes, if any) — not profile parsing.
- Diff `git diff --stat server/` — `handlers.go` should shrink by ~50 lines, no public-behaviour changes.
