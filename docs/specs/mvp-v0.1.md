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

- `media/{user_id}/{ulid}` — opaque encrypted blob, not content-addressed.
  Per-upload random AES-256-GCM key + IV means the same plaintext produces
  different ciphertext on each upload; a ULID path avoids collision-on-reupload.
  SHA-256 of plaintext lives in the referencing envelope for integrity only
  (see [Media](#media)).

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
    "url": "media/<user_id>/<ulid>",
    "key": "<base64 AES-256-GCM key>",
    "iv": "<base64 12-byte IV>",
    "name": "photo.jpg",
    "size": 48080
  }
}
```

See [Media](#media) for size limits, rendering rules, lifecycle, and failure handling.

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

## Media

Media blobs are encrypted client-side and stored at `media/{user_id}/{ulid}`.
Each upload uses a fresh random AES-256-GCM key and 12-byte IV. The key,
IV, display name, and plaintext size travel inside the Megolm-encrypted
envelope payload; the server sees only an opaque blob and its size.

### Per-blob size cap

- **25 MB ciphertext.** Enforced client-side before encryption (to avoid
  OOM during Web Crypto single-shot AES-GCM) and server-side at
  `POST /v1/store/presign` (`bytes` field is the ciphertext length).
- Oversize requests return `413 too_large`.
- Chunked uploads and streaming playback are deferred; see
  [evolution/large-media.md](../evolution/large-media.md).

### Presigned PUT headers

The presigned PUT URL is signed with `Content-Length` equal to the `bytes`
value from the presign request. S3 rejects PUTs whose body size differs,
so a client cannot smuggle a larger file through a small-signed URL.

`Content-Type` is **not** signed. The client sets
`Content-Type: application/octet-stream` on PUT; the stored object's
content type is therefore caller-controlled but irrelevant — reads flow
through `GET /v1/store/object`, which sets its own response headers
(`Cache-Control`, and `Content-Type: application/octet-stream` regardless
of what was stored). No other headers are signed.

### Per-user quota

Server enforces a per-user media quota at `POST /v1/store/presign`. Usage
is estimated by summing `Size` from `ListObjectsV2` on `media/{uid}/`,
cached in-process for 10 minutes, with optimistic increment on successful
presign. Presign returns `413 quota_exceeded` when
`cached_usage + bytes > quota`. Quota value v0.1: **1 GiB**.

The quota cache is in-process only, following the same "in-process now,
shared-state later" pattern as [EventHub](../decisions/adr-0004-sse-realtime-notifications.md):
v0.1 runs one container serving all traffic, so a `sync.Map` of
`user_id → {usage, expiresAt}` is sufficient. When multi-instance
deployment is introduced, the cache moves behind an interface backed by
Redis (or equivalent) without changing the presign API. Until then,
multi-instance drift is not a concern because there is no second instance.

Note that optimistic increment is only reverted on presign-path failures
(e.g. panic before response); a presign that succeeds but is never PUT to
leaves the increment in place until the 10 min TTL expires and
`ListObjectsV2` rebuilds from ground truth. This is intentional
conservatism — it prevents a client from defeating the quota by rapidly
presigning-without-uploading.

### Blob count cap

One `ListObjectsV2` page returns up to **1000 keys**. v0.1 caps per-user
blob count at **1000** so quota recomputation is a single S3 call; a
presign whose success would push the user over 1000 blobs returns `413
quota_exceeded` with the same code (the cap is a quota-management detail,
not a separate error). At the 1 GiB quota this is only restrictive for
users with many small attachments; the cap will be lifted when quota
bookkeeping moves to shared state and can afford paged enumeration or a
maintained counter.

### Integrity and failure handling

Before rendering, the recipient AES-256-GCM-decrypts with the key and IV
from the payload. If the auth tag fails → terminal `corrupt` state. GCM's
auth tag is the sole integrity check; no separate SHA-256 is carried or
verified.

A `GET /v1/store/object` returning `404` is terminal `unavailable`.
Network errors are transient `network-error` with a manual retry control;
there is no automatic retry loop. Attachment failure never hides the
containing message — the bubble still renders with timestamp and any
caption in `body`.

### Inline rendering rules

The client sniffs magic bytes of the decrypted plaintext. Only PNG, JPEG,
GIF, and WebP render inline via `<img>`. Everything else is exposed as a
download link (`<a download href="blob:...">`). SVG, AVIF, HEIC, video,
audio, and PDF are download-only in v0.1.

Blob URLs are never used as iframe or embed sources. Navigation to a blob
URL (click-through on the inline image, or following the download link)
is allowed — the browser renders the decoded bytes in a fresh context
without executing them as part of the app origin.

### Display-name hygiene

`file.name` is sender-controlled. Before using it as the `download`
attribute or as visible text, the client strips path separators (`/`,
`\`), NUL, and control characters (`\x00–\x1f`, `\x7f`), collapses
leading dots, truncates to 255 bytes, and falls back to `"download"`
when the result is empty.

### Client-side lifecycle

Decrypted attachments live in memory only, held as `ObjectURL`s owned by
the rendering component. Unmount revokes the URL and aborts any in-flight
fetch. Decrypted plaintext is never persisted to disk. Encrypted blobs
under `media/` are served with
`Cache-Control: private, immutable, max-age=31536000`, so browser HTTP
cache shortcuts the network leg on refresh — decryption still happens per
mount. Offline media and cross-session caching are deferred (see
[evolution/large-media.md](../evolution/large-media.md)).

### Upload reliability

- PUT failure: client retries once on network/5xx; second failure surfaces
  an inline "Upload failed — retry" control.
- Presigned URL expiry: client re-presigns and retries.
- `POST /v1/send` is idempotent by `msg_id`; the client retries the send
  leg independently of the PUT leg.

### Orphan blobs

If PUT succeeds but the send is abandoned (tab closed, send retries
exhausted), the blob is orphaned on S3. Server-side sweeps are not
possible under E2E — envelopes are opaque. Orphans count against the
per-user quota, and are reclaimed on account deletion.

In steady state, orphans are rare: orphan creation requires PUT-success
followed by send-abandonment, and the two legs are close-adjacent in
time with independent retries, so the realistic window is "tab closed
in the ~second between PUT and send." The 1 GiB / 1000-blob cap bounds
the worst case regardless.

Presigned-but-never-PUT reservations occupy cache usage (not real S3
bytes) for up to the 10 min TTL and are not reverted on timeout; this
is intentional friction against a presign-spam DoS, not a bug to fix.

Client-cooperative garbage collection and a future deletable-attachment
indirection are designed but not shipped in v0.1; see
[evolution/media-gc.md](../evolution/media-gc.md).

**Account deletion** (`DELETE /v1/profile`) wipes `media/{uid}/` along
with `inbox/`, `users/`, and `keys/`, using a single `ListObjects` page
per prefix (limit 1000). This is coupled to the 1000-blob cap above —
raising the cap also requires making the deletion loop paginate.

## Compaction

All data follows the same lifecycle: write immutable object → compact into archive → delete originals.

Compaction is triggered by the client after every sync that receives new
messages (fire-and-forget). Both inbox messages and key backups are compacted
in the same pass:

1. Client calls `POST /v1/store/compact` for the inbox prefix (up to the last synced key).
2. Client calls `POST /v1/store/compact` for the key-backup prefix (all live keys).
3. Server merges new live objects with any existing same-day archive,
   writes a single CBOR archive per date, deletes originals and old archives.

### Merge-on-compact algorithm

Multiple compactions may occur on the same calendar day (one per sync cycle).
The server maintains **one archive per day** by
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
| 413 | `too_large` | Single upload exceeds per-blob size cap |
| 413 | `quota_exceeded` | Upload would exceed per-user storage quota |

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
  See [evolution notes](../evolution/device-revocation.md).

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
    - Alice attaches a PNG fixture; it encrypts, uploads via presigned PUT
      to `media/{alice}/{ulid}`, and a media envelope is sent referencing
      it.
    - Bob receives the message via SSE; `<img>` is rendered inline; the
      rendered bytes hash equals the fixture hash.
    - Tampered blob: overwriting the stored ciphertext and opening the
      message in a fresh browser context (bypassing the immutable cache)
      causes Bob to see a terminal `corrupt` state; the message bubble
      still renders.
    - Refresh Bob's page in the same browser context: the inline image
      re-appears without a second `GET /v1/store/object` to the server
      (browser HTTP cache).
    - Oversize: attempting to attach a file >25 MB is rejected client-side
      before any network request.
    - Download variant: a small binary with no image magic renders as a
      download link, not an `<img>`.
