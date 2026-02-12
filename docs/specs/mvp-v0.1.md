# MVP v0.1 Spec

Status: draft (living document)

## Goals

- Two clients can register, exchange an invite, establish E2E, and exchange messages.
- Server stores and forwards opaque encrypted envelopes; clients own keys and history.
- Sync-first message delivery via S3 inbox objects.
- Multi-device per user via backup key.

## Non-goals

- Phone discovery / address book matching
- Groups
- Presence / typing indicators
- Server-side search
- Perfect realtime delivery (best-effort only)

## Components

### Client (PWA)

- Crypto:
    - Megolm for message encryption (even for 1:1)
    - Key shares encrypted with recipient's public key (derived from backup secret)
    - Via WASM (library TBD)
- Storage:
    - Keys/session state: IndexedDB
    - Chat history: IndexedDB
- Networking:
    - HTTP control plane
    - Optional WS for new-mail hints

### Server (Go)

- Stateless HTTP API (and optional WS).
- S3 client (S3-compatible endpoint).
- Minimal auth (device token).
- No crypto awareness — server handles opaque blobs.

### Storage (S3-compatible)

- Bucket/prefix layout; objects are immutable.
- One storage pattern everywhere: write immutable object → compact into archive → delete originals.

## IDs & naming

- `user_id`: ULID
- `device_id`: ULID
- `msg_id`: ULID (sender-generated)
- `session_id`: Megolm session identifier

## Storage layout (S3 keys)

Users and devices:

- `users/{user_id}/profile.json` — includes public keys (derived from backup secret)
- `users/{user_id}/devices/{device_id}.json`

Inbox (per user, not per device):

- `inbox/{user_id}/live/{msg_id}`
- `inbox/{user_id}/archive/{YYYY}-{MM}-{DD}`

Key backup (Megolm session keys, encrypted with backup key):

- `backups/{user_id}/keys/live/{session_id}`
- `backups/{user_id}/keys/archive/{YYYY}-{MM}-{DD}`

Invites (lookup index):

- `invites/{invite_handle}.json` — `{ "user_id": "..." }`

Media (encrypted by client):

- `media/{user_id}/{sha256}/{filename}`

## Multi-device

### Backup secret

At first registration, the client generates a random backup secret
(displayed as a word list or base64). The user saves it in a password manager.

Three keys are derived from the backup secret via HKDF:

- **Auth key** (asymmetric) — proves account ownership when adding devices.
  Public half stored in `profile.json`.
  Private half used only transiently during device addition, then discarded.
- **Sharing key** (asymmetric) — public half stored in `profile.json`.
  Other users encrypt Megolm session keys with it.
  Private half stored on device (IndexedDB) for ongoing key-share decryption.
- **Backup encryption key** (symmetric) — encrypts key backups on S3.
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
and encrypts the session key with Alice's sharing public key (from her profile).
He sends this as a key-share envelope to Alice's inbox.

All of Alice's devices can decrypt it — they all derive the same sharing private key
from the backup secret. No device enumeration needed. New devices added later
can decrypt old key shares from the inbox archive.

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
under `backups/{user_id}/keys/live/`. Compacted into daily archive objects like everything else.

On restore, the new device decrypts key backups with the backup encryption key,
then syncs the inbox normally — decrypting messages with the restored Megolm keys.

## Message immutability and state reconstruction

The system is append-only: the server stores immutable encrypted events,
and clients continuously sync and replay them to materialize chat state.
There is no server-side history rewriting.

## Envelope format

Messages and key shares are addressed to users, not devices.
The server does not need to know the recipient's device topology.

Fields:

- `v`
- `to_user`
- `from_user`, `from_device`
- `msg_id`
- `sent_at`
- `content_type` (e.g. `megolm.message`, `megolm.key_share`)
- `payload` (opaque to server)

## Compaction

All data follows the same lifecycle: write immutable object → compact into archive → delete originals.

Compaction is triggered by the client (e.g. on Megolm session rotation,
or after syncing and backing up received keys):

1. Client ensures all Megolm keys for messages up to cursor are in key backup.
2. Client calls `POST /v1/store/compact` with prefix and cursor.
3. Server (any stateless instance) reads live objects up to cursor,
   writes archive blob, deletes originals.

Safety properties:

- Compaction is idempotent. Two instances compacting the same messages produce identical output.
- No object is deleted before the archive is durably written.
- Crash during compaction may cause duplicates, never data loss.
- Readers tolerate duplicates via `msg_id` de-duplication.
- No locking required. Stateless instances can compact independently.

## API (HTTP)

### Auth

- Bearer token per device.
- Token issued at device registration.
- Tokens are long-lived and do not expire.
- Device revocation and token rotation are deferred to v0.2.
  A compromised device already holds the sharing private key and backup
  encryption key — revoking its token alone does not contain the breach.
  Meaningful revocation requires backup secret rotation (re-keying).

### Register (first device)

`POST /v1/register`

Input:

- `device_label`
- `auth_public_key`
- `sharing_public_key`

Output:

- `user_id`, `device_id`, `token`, `invite_handle`

### Add device

`POST /v1/devices`

Input:

- `user_id`
- `auth_proof` (signature over `{ user_id, device_id, timestamp }`)
- `device_label`

Output:

- `device_id`, `token`

### Resolve invite

`GET /v1/resolve/{invite_handle}`

Output:

- `user_id`
- `sharing_public_key`

### Send

`POST /v1/send`

Input:

- list of envelopes (addressed to users)

Server behavior:

- validate sender token
- write each envelope to recipient's inbox prefix

Sender includes a self-addressed envelope for their own inbox,
so sent messages are available on all devices via normal sync.

### Storage API (generic S3 proxy)

The server exposes three generic endpoints for all S3 operations.
Authorization is prefix-scoped: a user's token grants access only to their own prefixes
(`inbox/{user_id}/`, `backups/{user_id}/`, `media/{user_id}/`).

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

- list live objects under prefix up to cursor
- write archive blob
- delete compacted live objects

## Client sync algorithm

### Normal sync (existing device)

1. List `inbox/{user_id}/live/` via `store/list`, fetch new objects via `store/object`.
2. Process key-share envelopes first (decrypt with sharing private key, store Megolm keys).
   Write newly received Megolm keys to key backup via `store/presign`.
3. Decrypt message envelopes, store locally. Persist cursor and `msg_id` de-dup set.
4. If a message can't be decrypted (unknown session key from a sibling device),
   sync key backup (`store/list` on `backups/{user_id}/keys/`) for new keys, retry.

Realtime hint (optional):

- if WS connected, server can push `"new_mail": true`; client then syncs.

### New device sync

1. Restore Megolm session keys from `backups/{user_id}/keys/` (archive + live).
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
- Media:
    - upload encrypted blob via presigned PUT
    - send reference inside encrypted payload
    - recipient downloads and decrypts
