package main

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// validSalt is a 16-byte salt, base64url-unpadded — the on-the-wire shape
// the client sends from generateSalt().
var validSalt = b64url.EncodeToString(make([]byte, 16))

func validKDF() map[string]any {
	return map[string]any{"type": "argon2id", "m": 65536, "t": 3, "p": 1}
}

// registerV2 posts a v2 registration (password-derived keys + salt/kdf) and
// returns the decoded response.
func registerV2(t *testing.T, mux http.Handler, salt string, kdf map[string]any) *httptest.ResponseRecorder {
	t.Helper()
	pub, _, _ := ed25519.GenerateKey(nil)
	body := map[string]any{
		"handle":             nextTestHandle(),
		"device_label":       "v2 device",
		"auth_public_key":    b64url.EncodeToString(pub),
		"sharing_public_key": b64url.EncodeToString([]byte("sharing-key-placeholder-32bytes!")),
	}
	if salt != "" {
		body["salt"] = salt
	}
	if kdf != nil {
		body["kdf"] = kdf
	}
	raw, _ := json.Marshal(body)
	req := httptest.NewRequest("POST", "/v1/register", strings.NewReader(string(raw)))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	mux.ServeHTTP(w, req)
	return w
}

func TestRegisterV2StoresCredentialParams(t *testing.T) {
	store, mux, _ := testServer(t)

	w := registerV2(t, mux, validSalt, validKDF())
	if w.Code != http.StatusOK {
		t.Fatalf("register status = %d; body = %s", w.Code, w.Body.String())
	}
	var reg struct {
		UserID string `json:"user_id"`
		Handle string `json:"handle"`
	}
	json.NewDecoder(w.Body).Decode(&reg)

	// profile.json carries salt + kdf + key_version: 1
	profileData, err := store.GetObject(context.Background(), "users/"+reg.UserID+"/profile.json")
	if err != nil {
		t.Fatalf("reading profile: %v", err)
	}
	var p Profile
	if err := json.Unmarshal(profileData, &p); err != nil {
		t.Fatalf("unmarshal profile: %v", err)
	}
	if p.Salt != validSalt {
		t.Fatalf("profile salt = %q, want %q", p.Salt, validSalt)
	}
	if p.KDF == nil || p.KDF.Type != "argon2id" || p.KDF.M != 65536 || p.KDF.T != 3 || p.KDF.P != 1 {
		t.Fatalf("profile kdf = %+v, want argon2id/65536/3/1", p.KDF)
	}
	if p.KeyVersion != 1 {
		t.Fatalf("profile key_version = %d, want 1", p.KeyVersion)
	}

	// resolve surfaces them for the login fork
	rw := httptest.NewRecorder()
	mux.ServeHTTP(rw, httptest.NewRequest("GET", "/v1/resolve/"+reg.Handle, nil))
	if rw.Code != http.StatusOK {
		t.Fatalf("resolve status = %d; body = %s", rw.Code, rw.Body.String())
	}
	var resolved struct {
		Salt string     `json:"salt"`
		KDF  *KDFParams `json:"kdf"`
		KV   int        `json:"key_version"`
	}
	json.NewDecoder(rw.Body).Decode(&resolved)
	if resolved.Salt != validSalt {
		t.Fatalf("resolved salt = %q, want %q", resolved.Salt, validSalt)
	}
	if resolved.KDF == nil || resolved.KDF.M != 65536 {
		t.Fatalf("resolved kdf = %+v", resolved.KDF)
	}
	if resolved.KV != 1 {
		t.Fatalf("resolved key_version = %d, want 1", resolved.KV)
	}
}

func TestRegisterV1OmitsCredentialParams(t *testing.T) {
	store, mux, _ := testServer(t)

	// A v1 registration sends neither salt nor kdf.
	w := registerV2(t, mux, "", nil)
	if w.Code != http.StatusOK {
		t.Fatalf("register status = %d; body = %s", w.Code, w.Body.String())
	}
	var reg struct {
		UserID string `json:"user_id"`
		Handle string `json:"handle"`
	}
	json.NewDecoder(w.Body).Decode(&reg)

	// The three v2 keys must be absent on the wire (omitempty), not zero values.
	profileData, _ := store.GetObject(context.Background(), "users/"+reg.UserID+"/profile.json")
	var raw map[string]any
	json.Unmarshal(profileData, &raw)
	for _, k := range []string{"salt", "kdf", "key_version"} {
		if _, ok := raw[k]; ok {
			t.Fatalf("v1 profile.json should omit %q, got %v", k, raw[k])
		}
	}

	// resolve must also omit them.
	rw := httptest.NewRecorder()
	mux.ServeHTTP(rw, httptest.NewRequest("GET", "/v1/resolve/"+reg.Handle, nil))
	var resolvedRaw map[string]any
	json.Unmarshal(rw.Body.Bytes(), &resolvedRaw)
	for _, k := range []string{"salt", "kdf", "key_version"} {
		if _, ok := resolvedRaw[k]; ok {
			t.Fatalf("v1 resolve should omit %q, got %v", k, resolvedRaw[k])
		}
	}
}

func TestRegisterPartialCredentialParams(t *testing.T) {
	_, mux, _ := testServer(t)

	t.Run("salt without kdf", func(t *testing.T) {
		w := registerV2(t, mux, validSalt, nil)
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400; body = %s", w.Code, w.Body.String())
		}
	})
	t.Run("kdf without salt", func(t *testing.T) {
		w := registerV2(t, mux, "", validKDF())
		if w.Code != http.StatusBadRequest {
			t.Fatalf("status = %d, want 400; body = %s", w.Code, w.Body.String())
		}
	})
}

func TestRegisterMalformedKDF(t *testing.T) {
	_, mux, _ := testServer(t)

	cases := []struct {
		name string
		salt string
		kdf  map[string]any
		want int
	}{
		{"wrong type", validSalt, map[string]any{"type": "scrypt", "m": 65536, "t": 3, "p": 1}, http.StatusBadRequest},
		{"m zero", validSalt, map[string]any{"type": "argon2id", "m": 0, "t": 3, "p": 1}, http.StatusBadRequest},
		{"m over cap", validSalt, map[string]any{"type": "argon2id", "m": 2097152, "t": 3, "p": 1}, http.StatusBadRequest},
		{"t zero", validSalt, map[string]any{"type": "argon2id", "m": 65536, "t": 0, "p": 1}, http.StatusBadRequest},
		{"t over cap", validSalt, map[string]any{"type": "argon2id", "m": 65536, "t": 100, "p": 1}, http.StatusBadRequest},
		{"p zero", validSalt, map[string]any{"type": "argon2id", "m": 65536, "t": 3, "p": 0}, http.StatusBadRequest},
		{"empty salt", "", map[string]any{"type": "argon2id", "m": 65536, "t": 3, "p": 1}, http.StatusBadRequest},
		{"salt wrong length", b64url.EncodeToString(make([]byte, 8)), validKDF(), http.StatusBadRequest},
		{"canonical valid", validSalt, validKDF(), http.StatusOK},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := registerV2(t, mux, tc.salt, tc.kdf)
			if w.Code != tc.want {
				t.Fatalf("status = %d, want %d; body = %s", w.Code, tc.want, w.Body.String())
			}
		})
	}
}
