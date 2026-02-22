# MVP v0.1 Spec

Status: draft (living document)

## Goals

- Two clients can register, exchange an invite, establish E2E, and exchange messages.
- Server stores and forwards opaque encrypted envelopes; clients own keys and history.
- Sync-first message delivery via S3 inbox objects.
- Multi-device per user via backup key.

## Non-goals

See [vision non-goals](../vision.md#non-goals). Additionally: perfect realtime delivery (best-effort only).

## Components

### Client (PWA)

- Crypto:
    - Megolm for message encryption (even for 1:1) — via vodozemac WASM (~188KB)
    - Key shares encrypted with ECIES (X25519 + HKDF-SHA256 + AES-256-GCM) — via Web Crypto API
    - No Olm: the user-level sharing key replaces device-to-device key exchange
    - HKDF key derivation, Ed25519 signing, AES-256-GCM — all via Web Crypto API
- Storage:
    - Keys/session state: IndexedDB
    - Chat history: IndexedDB
- Networking:
    - HTTP control plane
    - SSE for realtime new-message hints

### Server (Go)

- Stateless HTTP API + in-memory SSE hub.
- S3 client (S3-compatible endpoint).
- Minimal auth (device token).

### Storage (S3-compatible)

- Bucket/prefix layout; objects are immutable.
- Single lifecycle everywhere: write → compact → delete (see [Compaction](#compaction)).

## IDs & naming

- `user_id`: ULID
- `device_id`: ULID
- `msg_id`: ULID (sender-generated)
- `session_id`: Megolm session identifier
- `handle`: two BIP39 words joined by hyphen (e.g. `copper-falcon`).
  Server-generated from the same 2048-word English wordlist used for backup mnemonics.
  ~22 bits of entropy (~4M combinations); sufficient for v0.1 namespace.
  Server retries on collision.

## Storage layout (S3 keys)

Users and devices:

- `users/{user_id}/profile.json` — includes public keys (derived from backup secret)
- `users/{user_id}/devices/{device_id}.json`

Inbox (per user, not per device):

- `inbox/{user_id}/live/{msg_id}`
- `inbox/{user_id}/archive/{YYYY}-{MM}-{DD}-{ULID}`

Key backup (Megolm session keys, encrypted with backup key):

- `keys/{user_id}/live/{session_id}`
- `keys/{user_id}/archive/{YYYY}-{MM}-{DD}-{ULID}`

Handles (lookup index):

- `handles/{handle}.json` — denormalized public profile (user_id, sharing key, display name, avatar)
- `users/{user_id}/contacts.json` — encrypted contacts blob (client-side AES-256-GCM)

Media (encrypted by client):

- `media/{user_id}/{sha256}/{filename}`

## Multi-device

### Backup secret

At first registration, the client generates a random backup secret:
128 bits (16 bytes), encoded as a 12-word BIP39 mnemonic.
The user saves it in a password manager.

Three keys are derived from the backup secret via HKDF-SHA256:

```
PRK = HKDF-Extract(salt="atmin.net", ikm=backup_secret)

auth_seed    = HKDF-Expand(PRK, info="auth-v1",    L=32)  → Ed25519 keypair
sharing_seed = HKDF-Expand(PRK, info="sharing-v1", L=32)  → X25519 keypair
backup_key   = HKDF-Expand(PRK, info="backup-v1",  L=32)  → AES-256-GCM key
```

Version suffixes (`-v1`) allow future derivation path changes without changing the backup secret.

- **Auth key** (Ed25519) — proves account ownership when adding devices.
  Public half stored in `profile.json`.
  Private half used only transiently during device addition, then discarded.
- **Sharing key** (X25519) — public half stored in `profile.json`.
  Other users encrypt Megolm session keys with it via ECIES.
  Private half stored on device (IndexedDB) for ongoing key-share decryption.
- **Backup encryption key** (AES-256-GCM) — encrypts key backups on S3.
  Stored on device (IndexedDB) for ongoing key backup writes.
  Never transmitted.

The backup secret itself is never persisted in the browser.
It is entered once (at registration or device addition), used to derive keys,
then discarded from memory. Only the sharing private key and backup encryption key
are stored on the device — the minimum needed for ongoing operation.

A compromised browser cannot add rogue devices (requires the auth key,
which requires the backup secret, which lives only in the user's password manager).

Losing the backup secret and all devices means unrecoverable loss of account and history.

### Adding a device

New device presents a signature over `{ user_id, device_id, timestamp }`
using the auth private key (derived from the backup secret the user provides).
Server verifies against the stored public key.

### Key sharing

When Bob starts a conversation with Alice, he creates a Megolm session
and encrypts the session key with Alice's sharing public key (from her profile)
using ECIES:

1. Generate ephemeral X25519 keypair
2. ECDH: `shared = ephemeral_private × alice_sharing_public`
3. `key = HKDF-SHA256(ikm=shared, salt="", info="atmin.net key share", L=32)`
4. `ciphertext = AES-256-GCM(key, session_key_bytes)`

He sends this as a key-share envelope to Alice's inbox (ephemeral public key + IV + ciphertext).

All of Alice's devices can decrypt it — they all derive the same sharing private key
from the backup secret. No device enumeration needed. New devices added later
can decrypt old key shares from the inbox archive.

No Olm — see [ADR-0002](../decisions/adr-0002-ecies-not-olm.md) for the full rationale.

Key shares are regular envelopes with a distinct `content_type`.
They flow through the same inbox, sync, and compaction as messages.
ULID ordering ensures key shares precede the messages they unlock.

### Megolm sessions are per-device

Each device creates its own Megolm session for sending. A new session is created
on app start and rotated after 100 messages, whichever comes first.
Rotation triggers a key backup write, key shares to active contacts, and
optionally a compaction request.

Megolm tracks a message index internally, so two devices cannot share a session
without index collisions.

If Alice has a phone (session S2) and a laptop (session S3), Bob receives
key shares for both and can decrypt messages from either device transparently.

Alice's phone gets S3 from the key backup (written by the laptop before its
first message). The normal sync algorithm handles this: if a message can't be
decrypted, the client syncs the key backup for new keys from sibling devices.

### Key backup

Each Megolm session key is also written as an individual encrypted object
under `keys/{user_id}/live/`. Compacted into daily archive objects like everything else.

On restore, the new device decrypts key backups with the backup encryption key,
then syncs the inbox normally — decrypting messages with the restored Megolm keys.

## Message immutability and state reconstruction

The system is append-only: the server stores immutable encrypted events,
and clients continuously sync and replay them to materialize chat state.
There is no server-side history rewriting.

## Envelope format

Live envelopes are JSON (one per S3 object):

```json
{
  "v": 1,
  "to_user": "01HWQA...",
  "from_user": "01HWQA...",
  "from_device": "01HWQA...",
  "msg_id": "01HWQA...",
  "sent_at": "2025-01-15T10:30:00Z",
  "content_type": "megolm.message",
  "payload": { ... }
}
```

### Payload by content type

**`megolm.message`** — Megolm-encrypted content:

```json
"payload": {
  "session_id": "...",
  "ciphertext": "<base64 Megolm ciphertext>"
}
```

Megolm inner plaintext (what gets encrypted/decrypted):

```json
{"type": "text", "body": "Hey Alice"}
```

Media reference (inside Megolm-encrypted plaintext):

```json
{
  "type": "media",
  "body": "photo.jpg",
  "file": {
    "url": "media/<user_id>/<sha256>/photo.jpg",
    "key": "<base64 AES-256-GCM key>",
    "iv": "<base64 12-byte IV>",
    "sha256": "<hex>"
  }
}
```

**`megolm.key_share`** — ECIES-encrypted Megolm session key:

```json
"payload": {
  "ephemeral_key": "<base64 X25519 public key, 32 bytes>",
  "iv": "<base64 12-byte IV>",
  "ciphertext": "<base64 AES-256-GCM ciphertext of session key>"
}
```

### Key backup objects

Individual live key backups are JSON, encrypted with the backup encryption key:

```json
{"iv": "<base64 12-byte IV>", "ciphertext": "<base64 AES-256-GCM>"}
```

The plaintext is the Megolm session key (base64, as returned by `session_key()`).

## Compaction

All data follows the same lifecycle: write immutable object → compact into archive → delete originals.

Compaction is triggered by the client (e.g. on Megolm session rotation,
or after syncing and backing up received keys):

1. Client ensures all Megolm keys for messages up to cursor are in key backup.
2. Client calls `POST /v1/store/compact` with prefix and cursor.
3. Server merges new live objects with any existing same-day archive,
   writes a single CBOR archive per date, deletes originals and old archives.

### Merge-on-compact algorithm

Multiple compactions may occur on the same calendar day (e.g. two session
rotations in a busy chat). The server maintains **one archive per day** by
merging:

1. List live objects under prefix up to cursor.
2. List existing archives for today (`{prefix}archive/{date}*`).
3. Read and decode any existing archives (CBOR → arrays of envelopes).
4. Merge: existing archive envelopes + new live envelopes.
5. Deduplicate by `msg_id` (first occurrence wins; objects without `msg_id`
   such as key backups are always kept).
6. Encode merged set as a single CBOR array.
7. Write new archive with a unique key: `{prefix}archive/{date}-{ULID}`.
8. Delete old archive(s) + compacted live objects.

The ULID suffix ensures each write produces a unique key. At steady state
there is exactly one archive per date. During the brief window between
writing the new archive and deleting the old one, two archives coexist —
the next compaction merges them.

### Archive format

Archives use CBOR (RFC 8949) — a binary format that supports raw byte strings
(no base64 overhead), is self-describing, and extensible.

Each archive object is a CBOR array of envelope maps:

```
CBOR array [
  {v: 1, to_user: h'...', from_user: h'...', msg_id: h'...', ...
   payload: {session_id: h'...', ciphertext: h'...'}},
  ...
]
```

ULIDs and ciphertext are stored as CBOR byte strings (raw, not base64).
This saves ~40% over JSON+base64 for typical messages.

Libraries: Go `github.com/fxamacker/cbor`, JS `cbor-x`.

### Safety properties

- No object is deleted before the new archive is durably written.
- Crash between write and delete may leave two archives for the same date;
  the next compaction merges and deduplicates them. Never data loss.
- Readers tolerate duplicates via `msg_id` de-duplication.
- No locking required. Stateless instances can compact independently.

## Binary encoding

All binary values in JSON API requests and responses (public keys, ciphertexts, IVs)
are encoded as **unpadded base64url** (RFC 4648 §5). This matches Web Crypto's
native export format and is URL-safe.

## Object schemas

### `users/{user_id}/profile.json`

Source of truth for all profile data (see [ADR-0005](../decisions/adr-0005-profiles-and-contacts.md)).

```json
{
  "user_id": "01HWQA...",
  "handle": "copper-falcon",
  "auth_public_key": "<base64url Ed25519, 32 bytes>",
  "sharing_public_key": "<base64url X25519, 32 bytes>",
  "display_name": "Alice",
  "avatar_url": "media/01HWQA.../avatar/photo.jpg",
  "last_active": "2026-02-15T10:30:00Z",
  "created_at": "2025-01-15T10:00:00Z"
}
```

`display_name`, `avatar_url`, and `last_active` are absent until set.

### `users/{user_id}/devices/{device_id}.json`

```json
{
  "device_id": "01HWQA...",
  "device_label": "Alice's laptop",
  "created_at": "2025-01-15T10:00:00Z"
}
```

## Error responses

All error responses use a consistent shape:

```json
{
  "error": "device_revoked",
  "message": "Device has been revoked"
}
```

Error codes used by the server:

| HTTP | `error` | Meaning |
|------|---------|---------|
| 400 | `bad_request` | Malformed input, missing fields |
| 401 | `unauthorized` | Missing or invalid token |
| 403 | `device_revoked` | Device file deleted (triggers client self-wipe) |
| 403 | `forbidden` | Prefix access denied |
| 404 | `not_found` | Object or handle does not exist |
| 413 | `quota_exceeded` | Upload exceeds storage quota |

## API (HTTP)

### Auth

- Bearer token per device: `Authorization: Bearer <token>`.
- Token issued at device registration; long-lived, no expiry.
- **Token format**: `base64url(user_id || "." || device_id || "." || HMAC-SHA256(server_secret, user_id || "." || device_id))`.
  Opaque to the client. Server parses `user_id` and `device_id` from the token
  and verifies the HMAC — no database lookup needed.
- **Revocation check**: server does S3 HEAD on `users/{user_id}/devices/{device_id}.json`,
  cached with short TTL. Missing file = `403 device_revoked`.
- Backup secret rotation (re-keying) is deferred.
  See [evolution notes](../evolution.md#device-revocation-and-key-rotation).

### Register (first device)

`POST /v1/register`

Input:

- `device_label`
- `auth_public_key` (base64url Ed25519)
- `sharing_public_key` (base64url X25519)

Server generates `user_id`, `device_id` (both ULIDs), `handle` (two BIP39 words),
and `token`.

Output:

- `user_id`, `device_id`, `token`, `handle`

This is the only unauthenticated endpoint (no existing token to present).

### Auth proof

Add-device and revoke-device require an `auth_proof`: an Ed25519 signature
over a JSON payload containing a timestamp.

```json
{
  "payload": { "user_id": "...", "device_id": "...", "timestamp": "2025-01-15T10:30:00Z" },
  "signature": "<base64url Ed25519 signature>"
}
```

Server verifies the signature against `auth_public_key` from `profile.json`.
**Replay protection**: reject if `timestamp` is more than 5 minutes from server time.

### Add device

`POST /v1/devices`

Input:

- `user_id`
- `auth_proof` (client generates `device_id` as ULID, includes it in signed payload)
- `device_label`

Output:

- `device_id`, `token`

### Revoke device

`POST /v1/devices/revoke`

Input:

- `device_id`
- `auth_proof`

Server deletes `users/{user_id}/devices/{device_id}.json`.
Subsequent API calls from the revoked device are rejected with `403 device_revoked`.

When a client receives `403 device_revoked`, it must wipe all local state
(IndexedDB keys, session keys, chat history, device token) and return to
the welcome screen. This is best-effort — an offline attacker won't trigger it —
but any network request from the stolen device causes self-wipe.

### Resolve handle

`GET /v1/resolve/{handle}`

Output:

- `user_id`
- `sharing_public_key`
- `display_name` (if set)
- `avatar_url` (if set)

### Send

`POST /v1/send`

Input:

- list of envelopes (addressed to users)

Server behavior:

- validate sender token
- verify `from_user` matches token's `user_id` and `from_device` matches token's `device_id`
- write each envelope to the addressed user's inbox prefix

Send is the only endpoint that writes to other users' prefixes.
The storage API (below) is restricted to the caller's own prefixes.

Sender includes a self-addressed envelope for their own inbox,
so sent messages are available on all devices via normal sync.

### Update profile

`PUT /v1/profile`

Input (both optional, omitted fields unchanged):

- `display_name`
- `avatar_url`

Server reads `profile.json`, merges fields, writes `profile.json` then
`handles/{handle}.json`. See [ADR-0005](../decisions/adr-0005-profiles-and-contacts.md).

### Delete account

`DELETE /v1/profile`

Deletes all user data: `users/{uid}/`, `inbox/{uid}/`, `keys/{uid}/`,
`media/{uid}/`, and `handles/{handle}.json`. Token is implicitly invalidated.
See [ADR-0005](../decisions/adr-0005-profiles-and-contacts.md).

### Saved Messages

A user can send messages to themselves by addressing envelopes to their own
`user_id` via `POST /v1/send`. These appear in the user's inbox like any
other message. The client routes `from_user == self` conversations to a
dedicated "Saved Messages" view.

No special server logic — this is a client-side routing convention over
the existing send/sync infrastructure.

### Realtime events

`GET /v1/events?token=...`

Server-Sent Events stream. The server notifies connected clients when new
messages arrive in their inbox. Clients respond by running the normal sync
algorithm. See [ADR-0004](../decisions/adr-0004-sse-realtime-notifications.md).

Auth token is passed as a query parameter (EventSource does not support
custom headers).

### Storage API (generic S3 proxy)

The server exposes three generic endpoints for all S3 operations.
Authorization is prefix-scoped: a user's token grants access only to their own prefixes
(`inbox/{user_id}/`, `keys/{user_id}/`, `media/{user_id}/`, `users/{user_id}/`).
Reads under `users/` are open (needed to fetch other users' public keys);
writes are restricted to own uid (see [ADR-0005](../decisions/adr-0005-profiles-and-contacts.md)).

The server has no knowledge of what the data means — it is an authenticated S3 proxy.

#### List objects

`GET /v1/store/list?prefix=...&limit=50&cursor=...`

Output:

- list of object keys matching prefix
- `next_cursor`

#### Get object

`GET /v1/store/object?key=...`
(or redirect to presigned GET)

#### Presign PUT

`POST /v1/store/presign`

Input:

- `key` (S3 object key)
- `bytes` (content length, for quota enforcement)

Output:

- presigned PUT URL

#### Compact

`POST /v1/store/compact`

Input:

- `prefix` (e.g. `inbox/alice01/live/`)
- `up_to` (cursor / msg_id)

Server behavior:

1. List live objects under prefix up to cursor.
2. If none → return `{archived: 0}`.
3. List existing same-day archives (`{prefix}archive/{today}*`).
4. Read and decode any existing archives (CBOR arrays).
5. Merge existing archive objects with new live objects; deduplicate by `msg_id`.
6. Write merged CBOR archive to `{prefix}archive/{today}-{ULID}`.
7. Delete old archive(s) and compacted live objects.

## Client sync algorithm

### Normal sync (existing device)

1. List `inbox/{user_id}/live/` via `store/list`, fetch new objects via `store/object`.
2. Process key-share envelopes first (decrypt with sharing private key, store Megolm keys).
   Write newly received Megolm keys to key backup via `store/presign`.
3. Decrypt message envelopes, store locally. Persist cursor and `msg_id` de-dup set.
4. If a message can't be decrypted (unknown session key from a sibling device),
   sync key backup (`store/list` on `keys/{user_id}/`) for new keys, retry.

Realtime hint:

- SSE connection (`GET /v1/events`) receives `new_message` events; client then syncs.

### New device sync

1. Restore Megolm session keys from `keys/{user_id}/` (archive + live).
2. Sync `inbox/{user_id}/live/` — most recent messages appear first.
3. Sync `inbox/{user_id}/archive/` in reverse date order — client walks backwards
   by constructing month prefixes (`archive/2025-06`, `archive/2025-05`, …).
   History fills in backwards.
4. Older archives can be fetched lazily (on scroll or in background).

## Reliability & idempotency

- `msg_id` is ULID; client retries are allowed.
- Client de-duplicates by `msg_id`.
- Server may overwrite the same inbox key with identical content.
- Compaction is idempotent (see Compaction section).

## Acceptance tests (definition of done)

- Two browser clients:
    - register
    - exchange invite
    - establish E2E session
    - send/receive messages
    - refresh and still decrypt previously received messages
- Multi-device:
    - add second device via backup key
    - new device syncs history from inbox + key backup
    - new device receives new messages going forward
- Offline delivery:
    - recipient closes tab, sender sends message
    - recipient opens later, syncs from inbox, decrypts
- Saved Messages:
    - send message to self
    - message appears in Saved Messages view
    - persists across refresh
- Profiles:
    - set display name
    - resolve handle shows display name
    - delete account, resolve returns 404, inbox and handle gone
- Write isolation:
    - presign upload to own `users/{uid}/contacts.json` succeeds
    - presign upload to another user's `users/` prefix returns 403
- Contacts:
    - encrypt contact list, upload via presigned PUT to `users/{uid}/contacts.json`
    - second device downloads and decrypts same contacts
- Activity tracking:
    - SSE connect sets `last_active` in profile
    - second SSE connect within 1 hour does not update `last_active`
- Media:
    - upload encrypted blob via presigned PUT
    - send reference inside encrypted payload
    - recipient downloads and decrypts
