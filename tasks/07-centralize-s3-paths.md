# Centralize S3 path constants across server and client

## Spec
`docs/specs/mvp-v0.1.md` "Storage layout (S3 keys)" defines every prefix:
- `users/{user_id}/profile.json`
- `users/{user_id}/devices/{device_id}.json`
- `users/{user_id}/contacts.json`
- `inbox/{user_id}/live/{msg_id}` and `inbox/{user_id}/archive/{date}-{ULID}`
- `keys/{user_id}/live/{session_id}` and `keys/{user_id}/archive/{date}-{ULID}`
- `handles/{handle}.json`
- `media/{user_id}/{ulid}`

`CONTRIBUTING.md` "S3 layout" reproduces the table; that file is the human-readable contract.

## Current
Every prefix is open-coded as a string concatenation in both Go and TypeScript:

- Server (`server/handlers.go`): `"users/" + userID + "/profile.json"`, `"users/" + userID + "/devices/" + deviceID + ".json"`, `"handles/" + handle + ".json"`, `"inbox/" + env.ToUser + "/live/" + env.MsgID`, etc.
- Server (`server/middleware.go`): `"users/" + userID + "/devices/" + deviceID + ".json"` for the revocation HEAD.
- Server (`server/media_quota.go`): `"media/" + userID + "/"`.
- Server (`server/handlers.go`) `authorizePrefix` / `authorizeKey` / `authorizeKeyWrite`: hardcodes the allow-list `["inbox/", "keys/", "media/"]`.
- Client (`web/src/lib/api.ts`): `inbox/${userId}/live/`, `inbox/${userId}/archive/`, `users/${userId}/profile.json`, `keys/${userId}/live/${sessionId}`, `keys/${userId}/live/`, `keys/${userId}/archive/`.
- Client (`web/src/lib/contact-backup.ts`, `web/src/lib/key-backup.ts`, `web/src/hooks/useDevices.ts`, `web/src/hooks/useConversations.ts`): more of the same.

Risk: changing a prefix in one place silently leaves the other broken. The compiler/linter cannot help.

## Change
Add small constants/helpers modules on each side. Do **not** generate one from the other — that's overkill for ~10 prefixes. Mirror them by hand and rely on the test suites + CI as the cross-check.

### Server: `server/paths.go`
```go
package main

func keyProfile(uid string) string         { return "users/" + uid + "/profile.json" }
func keyDevice(uid, did string) string     { return "users/" + uid + "/devices/" + did + ".json" }
func keyHandle(handle string) string       { return "handles/" + handle + ".json" }
func keyContacts(uid string) string        { return "users/" + uid + "/contacts.json" }
func prefixUser(uid string) string         { return "users/" + uid + "/" }
func prefixUserDevices(uid string) string  { return "users/" + uid + "/devices/" }
func prefixInbox(uid string) string        { return "inbox/" + uid + "/" }
func prefixInboxLive(uid string) string    { return "inbox/" + uid + "/live/" }
func prefixInboxArchive(uid string) string { return "inbox/" + uid + "/archive/" }
func keyInboxLive(uid, msgID string) string { return prefixInboxLive(uid) + msgID }
func prefixKeys(uid string) string         { return "keys/" + uid + "/" }
func prefixKeysLive(uid string) string     { return "keys/" + uid + "/live/" }
func prefixMedia(uid string) string        { return "media/" + uid + "/" }

// Allow-list shared by authorizePrefix / authorizeKey / authorizeKeyWrite.
var dataPrefixes = []string{"inbox/", "keys/", "media/"}
```

Replace every concatenated path in `handlers.go`, `middleware.go`, `media_quota.go` with the helpers. Replace the local `allowedPrefixes` in `handlers.go` with `dataPrefixes`.

### Client: `web/src/lib/paths.ts`
```ts
export const path = {
    profile: (uid: string) => `users/${uid}/profile.json`,
    device:  (uid: string, did: string) => `users/${uid}/devices/${did}.json`,
    handle:  (h: string) => `handles/${h}.json`,
    contacts: (uid: string) => `users/${uid}/contacts.json`,
    user:    (uid: string) => `users/${uid}/`,
    devices: (uid: string) => `users/${uid}/devices/`,
    inboxLive:    (uid: string) => `inbox/${uid}/live/`,
    inboxArchive: (uid: string) => `inbox/${uid}/archive/`,
    keysLive:     (uid: string) => `keys/${uid}/live/`,
    keysArchive:  (uid: string) => `keys/${uid}/archive/`,
    keyBackup:    (uid: string, sid: string) => `keys/${uid}/live/${sid}`,
    media:        (uid: string, ulid: string) => `media/${uid}/${ulid}`,
};
```

Replace all template literals in `api.ts`, `contact-backup.ts`, `key-backup.ts`, `useDevices.ts`, `useConversations.ts`.

### Documentation
- Keep `CONTRIBUTING.md` "S3 layout" table as the human-readable canonical reference.
- Add a one-line comment at the top of `server/paths.go` and `web/src/lib/paths.ts`: "If you change anything here, change it in the other file too, and update the table in CONTRIBUTING.md and the spec section in docs/specs/mvp-v0.1.md."

## Verify
- `make lint test` passes (Go + web).
- `grep -rn '"users/' server/*.go | grep -v paths.go | grep -v _test.go` returns nothing (or only the `var dataPrefixes = …` constants).
- Same grep on the client: `grep -rn 'users/\${\|inbox/\${\|keys/\${\|media/\${\|handles/\${' web/src --include='*.ts' --include='*.tsx' | grep -v paths.ts | grep -v test.ts` returns nothing.
- Existing e2e tests pass.
