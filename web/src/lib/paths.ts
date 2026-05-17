// If you change anything here, change it in server/paths.go too,
// and update the table in CONTRIBUTING.md and the spec in docs/specs/mvp-v0.1.md.

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
    keyBackup: (uid: string, sid: string) => `keys/${uid}/live/${sid}`,
    media: (uid: string, ulid: string) => `media/${uid}/${ulid}`,
};
