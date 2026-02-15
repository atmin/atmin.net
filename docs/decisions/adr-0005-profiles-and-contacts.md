# ADR-0005: Profiles and contacts storage

Status: Accepted
Date: 2026-02-15

## Context

The system currently stores a minimal profile at registration time
(`users/{uid}/profile.json`) containing only cryptographic keys and a timestamp.
There is no mechanism for users to set a display name, avatar, or manage contacts.

These are prerequisites for a usable messaging experience:
- Other users need to see a name and avatar when resolving an invite handle.
- Each user needs a private contact list that syncs across their devices.

The design must work within the existing S3 storage model (ADR-0001)
and preserve the E2E encryption guarantee — the server must not see
contact lists or their metadata.

## Decision

### Two-file profile model

**`users/{uid}/profile.json`** is the source of truth for all profile data.
It is the canonical record, written by the server on registration and profile updates.

```json
{
  "user_id": "01ABC...",
  "invite_handle": "crazy-badger",
  "auth_public_key": "...",
  "sharing_public_key": "...",
  "display_name": "Alice",
  "avatar_url": "media/01ABC.../avatar/photo.jpg",
  "created_at": "2026-02-15T..."
}
```

**`invites/{handle}.json`** is denormalized data — a projection of the public-facing
fields needed to resolve a handle and start a conversation.

```json
{
  "user_id": "01ABC...",
  "sharing_public_key": "...",
  "display_name": "Alice",
  "avatar_url": "media/01ABC.../avatar/photo.jpg"
}
```

On profile update, the server writes `profile.json` first (source of truth),
then `invites/{handle}.json`. Each `PutObject` is individually atomic —
readers always see a complete file, never a partial write.

If the server crashes between the two writes, the invite file may be stale.
This is self-correcting: the next profile update reads `profile.json`,
derives the current state, and writes both files again. The client can also
detect divergence during profile editing (it reads both files) and trigger
a re-sync.

### Why two files

Internal operations (add-device, revoke-device) look up the profile by user_id
to verify the auth public key. Moving the profile to `invites/{handle}.json` would
require a reverse lookup from user_id to handle, which does not exist.

The invite file serves a different audience: unauthenticated resolve requests and
future discovery services. Denormalizing the public fields avoids an extra S3 read
on every resolve and lets a discovery cache warm from a single `ListObjects("invites/")`
plus one `GetObject` per handle.

### PUT /v1/profile — profile update endpoint

A new authenticated endpoint for updating display name and avatar.

**Request:**

```json
{
  "display_name": "Alice",
  "avatar_url": "media/01ABC.../avatar/photo.jpg"
}
```

Both fields are optional — omitted fields are left unchanged.

**Server logic:**

1. Read `users/{uid}/profile.json` (source of truth).
2. Merge the submitted fields into the existing profile.
3. Write `users/{uid}/profile.json` with merged data.
4. Read `invite_handle` from the profile, project public fields,
   write `invites/{handle}.json`.
5. Return the updated profile.

The server owns both writes. The client never writes to `invites/` or
`users/{uid}/profile.json` directly — these prefixes are not in the
presign allow-list.

### Write authorization fix

The existing `authorizeKey` function allows any authenticated user to read
files under `users/` (needed to fetch other users' public keys). However,
presigned uploads also use `authorizeKey`, which means a user could presign
a write to another user's files.

This must be fixed: `store/presign` (writes) must restrict `users/` keys
to `users/{own_uid}/` only. Reads remain open. The simplest approach is
a separate `authorizeKeyWrite` function that enforces ownership for `users/`
while keeping the existing `authorizeKey` for read paths.

### Contacts

Contacts are stored as a single encrypted blob at:

```
users/{uid}/contacts.json
```

The file is encrypted client-side with the user's backup key (AES-256-GCM)
before upload. The server never sees the contact list contents.

Plaintext structure (before encryption):

```json
{
  "v": 1,
  "contacts": [
    {
      "user_id": "01BOB...",
      "handle": "crazy-badger",
      "display_name": "Bob",
      "sharing_public_key": "...",
      "added_at": "2026-02-15T..."
    }
  ]
}
```

The client reads this file via `GET /v1/store/object` and writes it via
`POST /v1/store/presign` (presigned upload). The write authorization fix
above ensures users can only presign writes to their own `users/{uid}/` prefix.
No new server-side logic is needed for contacts.

On adding a contact, the client:
1. Resolves the invite handle to get user_id and sharing_public_key.
2. Appends to the local contact list.
3. Encrypts and uploads `users/{uid}/contacts.json`.

All devices sync the same contacts file. Last-write-wins is acceptable here —
contact edits are infrequent and user-initiated.

### DELETE /v1/profile — account deletion endpoint

A new authenticated endpoint for self-service account deletion.

**Server logic:**

1. Read `users/{uid}/profile.json` to get `invite_handle`.
2. Delete all objects under `users/{uid}/`, `inbox/{uid}/`,
   `backups/{uid}/`, `media/{uid}/`.
3. Delete `invites/{handle}.json`.
4. Return 200.

This reuses the same delete-all-user-data logic as the automated cleanup
in ADR-0006. The token is invalidated implicitly — subsequent requests
fail because the profile no longer exists.

No confirmation step server-side. The client should confirm before calling.

### Avatar upload

Avatars use the existing presigned upload flow:
1. Client calls `POST /v1/store/presign` with key `media/{uid}/avatar/{hash}.jpg`.
2. Client uploads directly to S3 via the presigned URL.
3. Client calls `PUT /v1/profile` with the avatar_url set.

No new server-side logic needed.

## Consequences

### Requires

- New endpoint: `PUT /v1/profile` (authenticated, read-merge-write both files).
- New endpoint: `DELETE /v1/profile` (authenticated, deletes all user data).
- New function: `authorizeKeyWrite` (restricts `users/` writes to own uid).
- Update `handleRegister` to include `invite_handle` in `profile.json`.
- Update `handleStorePresign` to use `authorizeKeyWrite` instead of `authorizeKey`.

### Positive

- Profile updates use atomic S3 writes — no corrupt state possible.
- Contacts are E2E encrypted — the server never sees who talks to whom.
- No new storage infrastructure — everything uses existing S3 prefixes and endpoints.
- Discovery cache warmup is a simple ListObjects + parallel GetObjects on `invites/`.
- Avatar upload reuses the existing presigned URL flow.

### Negative

- Two files must be kept in sync on profile update. A crash between the two writes
  leaves the invite file stale. This is self-correcting on the next profile update
  or edit screen load (which reads both and can detect divergence).
- Last-write-wins for contacts means near-simultaneous edits from two devices
  could lose an addition. This is unlikely in practice and the user can re-add.
- The contacts file grows linearly with contact count. For the foreseeable scale
  (hundreds, not millions of contacts), a single JSON blob is fine.

### Deferred

- Visibility controls (public/private name, phone, email) can be added as fields
  to the profile without changing the storage layout.
- Phone/email-based discovery requires a separate index, likely backed by a database
  or search service. It does not affect this storage design.
- Contact blocking and muting are client-local flags within the encrypted contacts blob.
- Data retention policies (inactive user cleanup, abandoned registration pruning)
  require tracking `last_active` in profiles. Separate ADR.

## Alternatives considered

### Single profile at invites/{handle}.json

Rejected. Internal auth flows reference profiles by user_id. Storing the canonical
profile under the invite handle would require a user_id→handle reverse mapping
that doesn't exist and adds complexity.

### Server-side contacts database

Rejected. Leaks social graph metadata to the server. An encrypted client-side blob
preserves the E2E privacy guarantee from ADR-0001.

### Per-contact files

Rejected. Would create many small S3 objects and require listing + fetching each one
on sync. A single encrypted blob is simpler and faster for typical contact list sizes.
