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

- `inbox/{user_id}/live/{YYYY}/{MM}/{DD}/{msg_id}.msg`
- `inbox/{user_id}/archive/{YYYY}/{MM}/{DD}.blob`

Key backup (Megolm session keys, encrypted with backup key):

- `backups/{user_id}/keys/live/{session_id}.enc`
- `backups/{user_id}/keys/archive/{batch_id}.blob`

Media (encrypted by client):

- `media/{sha256}/{filename}`

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

### Key backup

Each Megolm session key is also written as an individual encrypted object
under `backups/{user_id}/keys/live/`. Compacted into archive blobs like everything else.

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

Compaction is triggered by Megolm session rotation:

1. Client rotates Megolm session.
2. Client writes new session key to key backup.
3. Client calls `POST /v1/inbox/compact` with a cursor.
4. Server (any stateless instance) reads live objects up to cursor,
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

### Inbox peek (sync)

`GET /v1/inbox/peek?limit=50&cursor=...`

Output:

- list of inbox keys (live and/or archive)
- `next_cursor`

### Inbox fetch (by key)

`GET /v1/inbox/object?key=...`
(or redirect to presigned GET)

### Inbox compact

`POST /v1/inbox/compact`

Input:

- `up_to` (cursor / msg_id)

Server behavior:

- list live objects up to cursor
- write archive blob
- delete compacted live objects

### Media presign

`POST /v1/media/presign`

Input:

- `sha256`, `filename`, `bytes`

Output:

- presigned PUT URL (and optionally GET)

## Client sync algorithm

### Normal sync (existing device)

1. Call `inbox/peek` to get newest keys from live prefix.
2. Fetch objects, decrypt payloads, store locally.
3. Persist cursor and `msg_id` de-dup set.

Realtime hint (optional):

- if WS connected, server can push `"new_mail": true`; client then peeks.

### New device sync

1. Restore Megolm session keys from `backups/{user_id}/keys/` (archive + live).
2. Sync `inbox/{user_id}/live/` — most recent messages appear first.
3. Sync `inbox/{user_id}/archive/` in reverse date order — history fills in backwards.
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
