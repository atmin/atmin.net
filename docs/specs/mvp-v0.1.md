# MVP v0.1 Spec

Status: draft (living document)

## Goals

- Two clients can register, exchange an invite, establish E2E, and exchange messages.
- Server stores and forwards opaque encrypted envelopes; clients own keys and history.
- Sync-first message delivery via S3 inbox objects.
- S3-compatible storage for messages and media.

## Non-goals

- Phone discovery / address book matching
- Groups
- Presence / typing indicators
- Server-side search
- Perfect realtime delivery (best-effort only)

## Components

### Client (PWA)

- Crypto: Matrix E2EE ecosystem (Olm/Megolm via WASM) for 1:1.
- Storage:
    - Keys/session state: IndexedDB
    - Chat history: IndexedDB (implementation detail)
- Networking:
    - HTTP control plane
    - Optional WS for new-mail hints

### Server (Go)

- Stateless HTTP API (and optional WS).
- S3 client (S3-compatible endpoint).
- Minimal auth (device token).

### Storage (S3-compatible)

- Bucket/prefix layout; objects are immutable.

## IDs & naming

- `user_id`: ULID
- `device_id`: ULID
- `msg_id`: ULID (sender-generated)

## Storage layout (S3 keys)

- `users/{user_id}/profile.json`
- `users/{user_id}/devices/{device_id}.json`
- `users/{user_id}/crypto/{device_id}/bundle.json`

Inbox (encrypted envelopes):

- `inbox/{user_id}/{device_id}/{YYYY}/{MM}/{DD}/{msg_id}.msg`

Media (encrypted by client):

- `media/{sha256}/{filename}`

(Optional later)

- `backups/{user_id}/{device_id}/...`

## Envelope format

Server-visible routing header + opaque encrypted payload.

Minimum fields:

- `v`
- `to_user`, `to_device`
- `from_user`, `from_device`
- `msg_id`
- `sent_at`
- `content_type` (hint)
- `payload` (opaque bytes)

## API (HTTP)

### Auth

- Bearer token per device.
- Token issued at device registration.

### Register

`POST /v1/register`

Input:

- `device_label`
- `crypto_bundle`

Output:

- `user_id`, `device_id`, `token`, `invite_handle`

### Resolve invite

`GET /v1/resolve/{invite_handle}`

Output:

- `user_id`
- device list + crypto bundle references

### Fetch crypto bundle

`GET /v1/users/{user_id}/crypto/{device_id}/bundle`

### Send

`POST /v1/send`

Input:

- list of envelopes (one per recipient device)

Server behavior:

- validate sender token
- write each envelope to recipient S3 inbox prefix

### Inbox peek (sync)

`GET /v1/inbox/peek?limit=50&cursor=...`

Output:

- list of inbox keys (or presigned GET URLs)
- `next_cursor`

Cursor strategy (v0.1):

- scan date prefixes (today backward) until `limit` is reached
- de-dup client-side by `msg_id`

### Inbox fetch (by key)

`GET /v1/inbox/object?key=...`
(or redirect to presigned GET)

### Media presign

`POST /v1/media/presign`

Input:

- `sha256`, `filename`, `bytes`

Output:

- presigned PUT URL (and optionally GET)

## Client sync algorithm (v0.1)

On app start / reconnect:

1. Call `inbox/peek` to get newest keys.
2. Fetch objects, decrypt payloads, store locally.
3. Persist cursor and `msg_id` de-dup set.

Realtime hint (optional):

- if WS connected, server can push `"new_mail": true`; client then peeks.

## Reliability & idempotency

- `msg_id` is ULID; client retries are allowed.
- Client de-duplicates by `msg_id`.
- Server may overwrite the same inbox key with identical content.

## Acceptance tests (definition of done)

- Two browser clients:
    - register
    - exchange invite
    - establish E2E session
    - send/receive messages
    - refresh and still decrypt previously received messages
- Offline delivery:
    - recipient closes tab, sender sends message
    - recipient opens later, syncs from inbox, decrypts
- Media:
    - upload encrypted blob via presigned PUT
    - send reference inside encrypted payload
    - recipient downloads and decrypts
