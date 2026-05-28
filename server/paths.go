package main

// If you change anything here, change it in web/src/lib/paths.ts too,
// and update the table in CONTRIBUTING.md and the spec in docs/specs/mvp-v0.1.md.

const usersRoot = "users/"

func keyProfile(uid string) string          { return "users/" + uid + "/profile.json" }
func keyDevice(uid, did string) string      { return "users/" + uid + "/devices/" + did + ".json" }
func keyHandle(handle string) string        { return "handles/" + handle + ".json" }
func keyContacts(uid string) string         { return "users/" + uid + "/contacts.json" }
func prefixUser(uid string) string          { return "users/" + uid + "/" }
func prefixUserDevices(uid string) string   { return "users/" + uid + "/devices/" }
func prefixInbox(uid string) string         { return "inbox/" + uid + "/" }
func prefixInboxLive(uid string) string     { return "inbox/" + uid + "/live/" }
func prefixInboxArchive(uid string) string  { return "inbox/" + uid + "/archive/" }
func keyInboxLive(uid, msgID string) string { return prefixInboxLive(uid) + msgID }
func prefixKeys(uid string) string          { return "keys/" + uid + "/" }
func prefixKeysLive(uid string) string      { return "keys/" + uid + "/live/" }
func prefixMedia(uid string) string         { return "media/" + uid + "/" }

// Rotation-records idempotency store: one tiny JSON blob per request_id,
// swept by the cleanup routine after the 24h TTL (ADR-0012).
func prefixRotationRecords(uid string) string { return "users/" + uid + "/rotation-records/" }
func keyRotationRecord(uid, requestID string) string {
	return prefixRotationRecords(uid) + requestID + ".json"
}

// Allow-list shared by authorizePrefix / authorizeKey / authorizeKeyWrite.
var dataPrefixes = []string{"inbox/", "keys/", "media/"}
