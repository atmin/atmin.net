// Mirrors the prefix/key conventions in server/src/paths.rs (server-built keys
// and the shared prefixes). `keyBackup` is client-only — the server presigns it
// but never constructs it. If you change anything here, mirror it there where it
// applies, and update the table in CONTRIBUTING.md and the spec in docs/specs/mvp-v0.1.md.

// A Megolm session_id is standard base64 (its alphabet includes `/` and `+`).
// Interpolated raw into an S3 key it can yield a leading/trailing/doubled `/`,
// an invalid object name that S3/MinIO reject (XMinioInvalidObjectName, 400) —
// silently losing that session's key backup. Make it an object-name-safe
// segment (base64url) first. The blob's body still carries the *raw* sid, so
// restore (which reads the body, not the key) is unaffected.
// See docs/scenarios/invariants/i10-key-backup-object-name-safe.md.
const objectNameSafe = (sid: string) =>
    sid.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const path = {
    profile: (uid: string) => `users/${uid}/profile.json`,
    device: (uid: string, did: string) => `users/${uid}/devices/${did}.json`,
    handle: (h: string) => `handles/${h}.json`,
    contacts: (uid: string) => `users/${uid}/contacts.json`,
    user: (uid: string) => `users/${uid}/`,
    devices: (uid: string) => `users/${uid}/devices/`,
    inboxLive: (uid: string) => `inbox/${uid}/live/`,
    inboxArchive: (uid: string) => `inbox/${uid}/archive/`,
    keysLive: (uid: string) => `keys/${uid}/live/`,
    keysArchive: (uid: string) => `keys/${uid}/archive/`,
    keyBackup: (uid: string, sid: string) =>
        `keys/${uid}/live/${objectNameSafe(sid)}`,
    keyChain: (uid: string) => `keys/${uid}/key_chain.json`,
    media: (uid: string, ulid: string) => `media/${uid}/${ulid}`,
};
