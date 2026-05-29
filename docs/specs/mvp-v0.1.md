# MVP v0.1 Spec

Status: scope frozen — the v0.1 surface is fixed and nearly complete
(remaining work in [tasks/](../../tasks/README.md)). New surface area
(starting with background delivery) lives in
[mvp-v0.2.md](mvp-v0.2.md), not here.

## Goals

- Two clients can register, exchange an invite, establish E2E, and exchange messages.
- Server stores and forwards opaque encrypted envelopes; clients own keys and history.
- Sync-first message delivery via S3 inbox objects.
- Multi-device per user via a password-derived backup key (Argon2id; ADR-0011).
- Self-service credential rotation ("change password") with multi-device cutoff (ADR-0012).
- User-chosen handles with reserved-list + cooldown semantics (ADR-0013).
- Message edit and delete via amendment envelopes (ADR-0014).
- Self-service account deletion, plus server-side cleanup of abandoned data and storage-usage visibility.

## Non-goals

See [vision non-goals](../vision.md#non-goals). Additionally: perfect realtime delivery (best-effort only).

## Components

### Client (PWA)

- Crypto:
    - Megolm for message encryption (even for 1:1) — via vodozemac WASM (~188KB)
    - Key shares encrypted with ECIES (ECDH P-256 + HKDF-SHA256 + AES-256-GCM) — via Web Crypto API
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
- `handle`: user-chosen ASCII string matching
  `^[a-z][a-z0-9-]{1,30}[a-z0-9]$` — 3–32 characters,
  lowercase letters / digits / hyphens, must start with a letter
  and end with a letter or digit, no consecutive hyphens. See
  [ADR-0013](../decisions/adr-0013-user-chosen-handles.md).
  Validated and reserved-list-checked at registration. Atomic
  claim is enforced by an in-server per-handle mutex (see
  [ops.md — Object storage constraints](../ops.md#object-storage-constraints)).
  A "Surprise me" UI option generates a random BIP39
  two-word candidate client-side; the user can edit before
  submission. PWA URLs use the `/@{handle}` prefix to keep
  user routes separate from system routes; the bare handle
  is what the API and S3 keys store.

## Storage layout (S3 keys)

Users and devices:

- `users/{user_id}/profile.json` — includes public keys (derived from backup secret)
- `users/{user_id}/devices/{device_id}.json`
- `users/{user_id}/rotation-records/{request_id}.json` — idempotency record
  for `POST /v1/rotate-keys`; recorded outcome (token + key_version on
  success, error code + current kv on failure). 24h TTL; swept by the
  cleanup routine. See [Rotate keys](#rotate-keys) and
  [ADR-0012](../decisions/adr-0012-backup-secret-rotation.md).

Inbox (per user, not per device):

- `inbox/{user_id}/live/{msg_id}`
- `inbox/{user_id}/archive/{YYYY}-{MM}-{DD}-{ULID}`

Key backup (Megolm session keys, encrypted with the current backup key):

- `keys/{user_id}/live/{session_id}`
- `keys/{user_id}/archive/{YYYY}-{MM}-{DD}-{ULID}`
- `keys/{user_id}/key_chain.json` — links of historical backup keys
  encrypted by their successors. Written on rotation; absent for
  accounts that have never rotated. See [Backup secret](#backup-secret)
  and [Key chain](#key-chain).

Handles (lookup index):

- `handles/{handle}.json` — denormalized public profile
  (user_id, sharing key, salt, kdf, key_version, display name,
  avatar) for a live handle, OR a tombstone
  `{ "released_at": "..." }` for a handle in 30-day cooldown after
  account deletion. See [ADR-0013](../decisions/adr-0013-user-chosen-handles.md).
- `users/{user_id}/contacts.json` — encrypted contacts blob (client-side AES-256-GCM)

Media (encrypted by client):

- `media/{user_id}/{ulid}` — opaque encrypted blob, not content-addressed.
  Per-upload random AES-256-GCM key + IV means the same plaintext produces
  different ciphertext on each upload; a ULID path avoids collision-on-reupload.
  SHA-256 of plaintext lives in the referencing envelope for integrity only
  (see [Media](#media)).

## Multi-device

### Backup secret

The backup secret is a 16-byte value used as input to HKDF-SHA256.
Three keys are derived from it (Ed25519 auth, P-256 sharing, AES-256-GCM
backup) via the same HKDF chain used since v0.1; the derivation path is
unchanged. What changed is how the 16-byte value gets produced.

#### Credential paths (v2)

New accounts (v2) take a user-typed password and stretch it through
Argon2id to produce the 16-byte secret. The password+salt+params live
nowhere; only the derived secret reaches HKDF, and only the public
outputs of HKDF reach the server. See
[ADR-0011](../decisions/adr-0011-credential-derivation.md) for the full
rationale.

```
backup_secret = Argon2id(
    password = <user_utf8>,
    salt     = <16 random bytes, per-account>,
    m        = <from profile.kdf>,
    t        = <from profile.kdf>,
    p        = <from profile.kdf>,
    hash_len = 16
)

PRK = HKDF-Extract(salt="atmin.net", ikm=backup_secret)
auth_seed    = HKDF-Expand(PRK, info="auth-v1",    L=32)  → Ed25519 keypair
sharing_seed = HKDF-Expand(PRK, info="sharing-v1", L=32)  → P-256 keypair (scalar)
backup_key   = HKDF-Expand(PRK, info="backup-v1",  L=32)  → AES-256-GCM key
```

Argon2id runs in a Web Worker. The default parameters at registration
are `m=65536 KiB, t=3, p=1`. The chosen `(salt, m, t, p)` are stored on
`profile.json` and surfaced via `GET /v1/resolve/{handle}` so any device
can re-derive the same keys from the password.

The credential field used to be a 12-word BIP39 mnemonic; that path was
removed once every account had migrated to the password flow. Every
`profile.json` now carries `salt`, `kdf`, and `key_version`.

Version suffixes (`-v1`) on the HKDF `info` strings allow future
derivation path changes without changing the backup secret itself. Their
`-v1` is the HKDF info version and is unrelated to the (now-removed)
credential v1/v2 split.

#### Key roles

- **Auth key** (Ed25519) — proves account ownership when adding
  devices and when rotating the credential. Public half stored in
  `profile.json`. Private half used only transiently and discarded.
- **Sharing key** (ECDH P-256) — public half stored in `profile.json`
  as uncompressed SEC1 (65 bytes, `0x04 || X || Y`). Other users
  encrypt Megolm session keys with it via ECIES. Private half stored
  on device (IndexedDB) as a **non-extractable** CryptoKey. See
  [ADR-0008](../decisions/adr-0008-p256-sharing-keypair.md).
- **Backup encryption key** (AES-256-GCM) — encrypts key backups on
  S3. Stored on device (IndexedDB) for ongoing writes. Never
  transmitted.

The backup secret itself is never persisted in the browser. The
password is entered once per device, stretched, and the derived
secret is discarded as soon as the three keys are derived.
Only the sharing private key and current backup encryption key remain
on the device — the minimum needed for ongoing operation.

A compromised browser cannot add rogue devices (requires the auth
key, which requires the secret, which requires the password the user
keeps in their password manager).

Losing the password and all devices means unrecoverable loss of
account and history. There is no recovery mechanism.

#### Key rotation

The credential and all derived keys can be rotated atomically via
`POST /v1/rotate-keys`. Rotation:

1. Derives new keys from a new password and a freshly generated salt.
2. Atomically replaces the public keys in `profile.json`, with a
   continuity signature proving possession of the old auth private
   key. Concurrency is enforced by an in-server per-`user_id` mutex
   (see [ADR-0012](../decisions/adr-0012-backup-secret-rotation.md)
   and [ops.md — Object storage constraints](../ops.md#object-storage-constraints)).
3. Bumps `profile.key_version` by one.
4. Appends a link to `keys/{uid}/key_chain.json` so historical
   key-backup blobs encrypted with the previous backup key remain
   readable.
5. Issues a new bearer token to the rotating device, bound to the
   new `key_version`.

All other devices on the account are cut off immediately: their
tokens are bound to the old `key_version` and fail authentication
on next request. The user must re-enter the new password on each
other device. See [Rotate keys](#rotate-keys) and
[ADR-0012](../decisions/adr-0012-backup-secret-rotation.md).

#### Login

The login screen has a single password field. The client fetches
`salt` and `kdf` from `GET /v1/resolve/{handle}`, runs Argon2id with
those parameters in a Web Worker, then HKDF. There is no fork — the
credential is always a password.

### Adding a device

New device presents a signature over `{ user_id, device_id, timestamp }`
using the auth private key (derived from the backup secret the user provides).
Server verifies against the stored public key.

### Key sharing

When Bob starts a conversation with Alice, he creates a Megolm session
and encrypts the session key with Alice's sharing public key (from her profile)
using ECIES:

1. Generate ephemeral P-256 keypair
2. ECDH: `shared = x-coord(ephemeral_private × alice_sharing_public)` (32 bytes)
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

For accounts that have rotated, each key-backup blob carries a `v`
field identifying which `key_version`'s backup key encrypted it. A
restoring device that has only the current backup key walks
[`keys/{user_id}/key_chain.json`](#key-chain) backwards to recover
older backup keys on demand.

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

Amendment to a prior message (inside Megolm-encrypted plaintext):

```json
{
  "type": "amendment",
  "target_msg_id": "01HWQA...",
  "action": "edit",
  "body": "Hey Alice, fixed the typo"
}
```

```json
{
  "type": "amendment",
  "target_msg_id": "01HWQA...",
  "action": "delete"
}
```

An amendment is a regular `megolm.message` envelope whose
decrypted plaintext refers to a prior message by `target_msg_id`.
The amendment is encrypted with the sender's *current* Megolm
session (not the original's session) and addressed to the same
recipients as the original — including a self-copy for the
sender's other devices.

`target_msg_id` lives inside the encrypted plaintext, so the
server never learns which message is being amended.

`action`:

- `"edit"` — `body` is the replacement text. For a media
  message with a caption, only the caption changes; the media
  reference is unchanged. For a pure-media message (no
  caption), `action: "edit"` is malformed and ignored by the
  recipient's materializer.
- `"delete"` — recipient renders the original as a
  `[deleted]` placeholder. The sender additionally issues
  `DELETE /v1/store/object` on the underlying
  `media/{uid}/{ulid}` blob if the original was a media
  message; the recipient drops any local IDB cache of the
  decrypted blob.

Authorization is enforced by the recipient at materialization
time: an amendment is applied only if its `from_user` matches
the original's `from_user`. Megolm session integrity provides
the cryptographic proof; no additional signature is needed.

There is no edit/delete time window. Amendments work for the
life of the conversation. The UI tags edits with the
amendment's `sent_at` so long-after edits read visually loud.

Clients that encounter an amendment with an unrecognized
`action` value drop the envelope silently from materialization
(forward compatibility for future amendment kinds).

See [ADR-0014](../decisions/adr-0014-message-amendments.md) for
the full design, including the two-pass materializer and the
edit-chain storage model.

**`megolm.key_share`** — ECIES-encrypted Megolm session key:

```json
"payload": {
  "ephemeral_key": "<base64 P-256 public key, uncompressed SEC1, 65 bytes>",
  "iv": "<base64 12-byte IV>",
  "ciphertext": "<base64 AES-256-GCM ciphertext of session key>"
}
```

### Key backup objects

Individual live key backups are JSON, encrypted with the **current**
backup encryption key:

```json
{"v": 1, "iv": "<base64 12-byte IV>", "ciphertext": "<base64 AES-256-GCM>"}
```

The plaintext is the Megolm session key (base64, as returned by
`session_key()`).

The outer `v` field identifies which `key_version`'s backup key
encrypted this blob. Every blob written carries `v`; on read, a
missing `v` is defensively treated as `v: 1` (write-once key blobs are
never rewritten by rotation or compaction, so a stray pre-versioning
blob stays readable rather than dropping that session's history).
When reading a blob with `v: N` while
the account is at `key_version: M` and `N < M`, the client walks
[`keys/{uid}/key_chain.json`](#key-chain) backwards from `M` to `N`
to recover the right backup key.

Archives are CBOR arrays of these envelopes; each entry
self-describes its version, so a single archive can contain blobs
from multiple `key_version`s when a rotation lands between
compactions. The reader decrypts each entry independently.

`users/{user_id}/contacts.json` follows the same envelope.

### Key chain

`keys/{user_id}/key_chain.json` is written on rotation. It carries
the historical backup keys, each wrapped by its successor:

```jsonc
{
  "links": [
    {
      "from":       1,           // older key_version
      "to":         2,           // newer key_version
      "iv":         "<base64 12-byte IV>",
      "ciphertext": "<base64 AES-256-GCM>"
    }
    // ...one link appended per rotation
  ]
}
```

`ciphertext` is `AES-256-GCM(backup_key_to, backup_key_from)` — the
older backup key encrypted by the newer. The rotating device, which
holds both keys at the moment of rotation, writes the new link
before invoking `POST /v1/rotate-keys`. Links are append-only;
existing links are never rewritten.

On read of a blob with `v: N` while the current `key_version` is
`M`, a client that has `backup_key_M` in IndexedDB walks the
`links` array backwards (`M → M-1 → … → N`), decrypting each link's
`ciphertext` to recover the next-older backup key, until it reaches
`backup_key_N`. Recovered keys should be memoized in IndexedDB to
amortize subsequent reads.

The file itself is unencrypted at the envelope level — only its
`ciphertext` fields are encrypted. Its existence reveals that at
least one rotation occurred but not when, with what parameters, or
how many.

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
`Cache-Control: public, immutable, max-age=31536000`, so browser HTTP
cache shortcuts the network leg on refresh — decryption still happens per
mount. `public` is required because RFC 9111 §3.5 prevents caching
responses to credentialed requests unless the response explicitly opts in;
the blobs are GCM-sealed ciphertext so shared caching is safe. Offline media and cross-session caching are deferred (see
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

```jsonc
{
  "user_id": "01HWQA...",
  "handle": "copper-falcon",
  "auth_public_key": "<base64url Ed25519, 32 bytes>",
  "sharing_public_key": "<base64url P-256 uncompressed SEC1, 65 bytes>",

  // Credential params (ADR-0011 + ADR-0012). Always present.
  "salt":        "<base64url, 16 bytes>",
  "kdf":         { "type": "argon2id", "m": 65536, "t": 3, "p": 1 },
  "key_version": 1,

  // Profile fields (ADR-0005). Absent until set.
  "display_name": "Alice",
  "avatar_url":   "media/01HWQA.../avatar/photo.jpg",
  "last_active":  "2026-02-15T10:30:00Z",

  "created_at":  "2025-01-15T10:00:00Z"
}
```

`display_name`, `avatar_url`, and `last_active` are absent until set.
`salt`, `kdf`, and `key_version` are always present together.
`key_version` is initialised to `1` at registration and bumps by one
on each rotation. `kdf.m` is in KiB per the Argon2 spec convention.

### `users/{user_id}/devices/{device_id}.json`

```jsonc
{
  "device_id":    "01HWQA...",
  "device_label": "Alice's laptop",
  "created_at":   "2025-01-15T10:00:00Z"
}
```

v0.2 adds an optional `push_subscription` field to this record for
Web Push delivery; see [mvp-v0.2.md](mvp-v0.2.md).

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
| 400 | `handle_invalid` | Requested handle violates the charset/length rules ([IDs & naming](#ids--naming)) |
| 400 | `handle_reserved` | Requested handle is on the server reserved list |
| 401 | `unauthorized` | Missing or invalid token |
| 401 | `key_version_stale` | Token or auth-proof bound to a superseded `key_version`. Body: `{ "error": "key_version_stale", "current": N }` — client must wipe local state and prompt for the new credential |
| 403 | `device_revoked` | Device file deleted (triggers client self-wipe) |
| 403 | `forbidden` | Prefix access denied |
| 403 | `bad_continuity` | `continuity_signature` on a `rotate-keys` request did not verify against the current `profile.auth_public_key` |
| 404 | `not_found` | Object or handle does not exist |
| 409 | `key_version_stale` | `rotate-keys` request's `key_version` did not equal `profile.key_version + 1` |
| 409 | `handle_taken` | Requested handle is currently registered to another account |
| 409 | `handle_in_cooldown` | Requested handle is in 30-day cooldown after deletion. Body: `{ "error": "handle_in_cooldown", "released_at": "...", "available_at": "..." }` |
| 410 | `released` | `GET /v1/resolve/{handle}` for a handle in cooldown. Body: `{ "released_at": "...", "available_at": "..." }` |
| 413 | `too_large` | Single upload exceeds per-blob size cap |
| 413 | `quota_exceeded` | Upload would exceed per-user storage quota |
| 503 | `registration_unavailable` | Multi-instance only: the shared coordination store hosting the handle-claim mutex is unreachable |
| 503 | `rotation_unavailable` | Multi-instance only: the shared coordination store hosting the rotation mutex is unreachable. Body: `{ "retry_after_seconds": N }`. Single-instance deployments never emit this |

## API (HTTP)

### Auth

- Bearer token per device: `Authorization: Bearer <token>`.
- Token issued at device registration or rotation; long-lived, no expiry,
  but bound to the `key_version` in force when it was issued.
- **Token format**:
  ```
  base64url(
      user_id || "." ||
      device_id || "." ||
      key_version || "." ||
      HMAC-SHA256(server_secret, user_id || "." || device_id || "." || key_version)
  )
  ```
  Opaque to the client. The HMAC covers `key_version` so the client cannot
  forge a token for a different version. This four-segment shape is the
  only accepted form; the legacy three-segment (no-`key_version`) token is
  rejected.
- **Auth middleware**:
  1. Parse the token; verify HMAC.
  2. Read current `profile.key_version` (cached). Treat absence as `1`.
  3. Reject with `401 key_version_stale` if the token's `key_version`
     does not match. Response body includes `{ "current": N }` so
     the client can render the right re-login UX.
  4. Do the existing S3 HEAD revocation check.
- **Revocation check**: server does S3 HEAD on `users/{user_id}/devices/{device_id}.json`,
  cached with short TTL. Missing file = `403 device_revoked`.
- See [ADR-0012](../decisions/adr-0012-backup-secret-rotation.md)
  for the full rotation mechanism.

### Register (first device)

`POST /v1/register`

Input:

- `handle` (user-chosen, must match the rules in [IDs & naming](#ids--naming))
- `device_label`
- `auth_public_key` (base64url Ed25519)
- `sharing_public_key` (base64url P-256 uncompressed SEC1)
- `salt` (base64url, 16 bytes — required)
- `kdf` (object `{ type, m, t, p }` — required)

The client generates a random `salt`, runs Argon2id over the user's
password, and derives the auth and sharing keypairs from the resulting
16-byte secret. The salt and KDF parameters are sent alongside the
public keys. The server stores all of `auth_public_key`,
`sharing_public_key`, `salt`, `kdf`, and `key_version: 1` (the rotation
counter starts at 1; it is bumped on each rotation) into `profile.json`.
A request missing either `salt` or `kdf`, or carrying only one of the
pair, is rejected `400 bad_request`.

Handle claim flow (see
[ADR-0013](../decisions/adr-0013-user-chosen-handles.md) for the
full design):

1. Server validates `handle` against the charset/length rules.
   Reject `400 handle_invalid` on format violations or
   `400 handle_reserved` on reserved-list matches.
2. Server acquires the per-handle in-server mutex (short timeout;
   on timeout return `503 registration_unavailable`).
3. Server `GET handles/{handle}.json`:
   - `404` → handle is free.
   - `200` with live projection → reject `409 handle_taken`.
   - `200` with `released_at` in the future → reject
     `409 handle_in_cooldown` (body includes `released_at`).
   - `200` with `released_at` in the past → `DeleteObject` the
     stale tombstone, continue.
4. Server generates `user_id`, `device_id`, `token`.
5. Server writes `handles/{handle}.json` (unconditional; the mutex
   makes the GET+PUT effectively atomic for this handle).
6. Server writes `users/{user_id}/profile.json` and
   `users/{user_id}/devices/{device_id}.json`. If either fails,
   best-effort `DeleteObject` the handle projection to release
   the handle.
7. Server releases the mutex.

Output:

- `user_id`, `device_id`, `token`, `handle`

This is the only unauthenticated endpoint (no existing token to present).

### Auth proof

Add-device and revoke-device require an `auth_proof`: an Ed25519
signature over a JSON payload. Rotate-keys uses a related but distinct
`continuity_signature` (over the whole request body sans the signature
field) — see [Rotate keys](#rotate-keys). All use the same
JCS-canonicalization rules.

**Payload** — a single shape, always carrying `key_version`:

```json
{
  "payload": {
    "user_id":     "...",
    "device_id":   "...",
    "timestamp":   "2025-01-15T10:30:00Z",
    "key_version": 1
  },
  "signature": "<base64url Ed25519 signature>"
}
```

The payload is signed over its **JCS-canonicalized**
([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785)) bytes — recursive
lexicographic key ordering, no whitespace, RFC 8259 string escapes,
numbers in shortest round-tripping form. The client uses
[`canonicalize`](https://www.npmjs.com/package/canonicalize); the
server uses [`github.com/gowebpki/jcs`](https://github.com/gowebpki/jcs).
A payload with no `key_version` (the legacy, non-canonical shape) is
rejected.

Server verifies the signature against `auth_public_key` from
`profile.json`. Server rejects with `401 key_version_stale` if the
payload's `key_version` does not match the current
`profile.key_version`. **Replay protection**: reject if `timestamp`
is more than 5 minutes from server time.

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

### Rotate keys

`POST /v1/rotate-keys`

Atomically replaces the credential-derived keys on an account. See
[ADR-0012](../decisions/adr-0012-backup-secret-rotation.md) for the
full design.

Input:

```jsonc
{
  "request_id":           "<UUID v4>",               // idempotency key
  "key_version":          2,                         // = current + 1
  "auth_public_key":      "<base64url>",
  "sharing_public_key":   "<base64url>",
  "salt":                 "<base64url, 16 bytes>",
  "kdf":                  { "type": "argon2id", "m": 65536, "t": 3, "p": 1 },
  "continuity_signature": "<base64url Ed25519>"
}
```

The `continuity_signature` is an Ed25519 signature, produced by the
**old** auth private key, over the JCS-canonicalized form of the
request body excluding the `continuity_signature` field itself.
`request_id` is part of the canonicalized payload, so an attacker
cannot replay an idempotency record by reusing a captured signed
body without also reusing the bound token.

Server flow:

1. Authenticate the bearer token (existing middleware, including the
   `key_version` check).
2. **Acquire the in-server per-`user_id` rotation mutex** (see
   [ADR-0012 — Concurrency control](../decisions/adr-0012-backup-secret-rotation.md)).
   On contention with a short timeout (~500 ms), return
   `503 rotation_unavailable`.
3. Check `users/{user_id}/rotation-records/{request_id}.json`. If
   present, replay the recorded outcome (token + key_version, or
   the recorded error) without re-running the rotation.
4. Read current `profile.json`.
5. Reject `409 key_version_stale` if `request.key_version !=
   profile.key_version + 1`.
6. Verify `continuity_signature` against the current
   `profile.auth_public_key`. On failure, return `403 bad_continuity`.
7. Build the new `profile.json` from the request fields plus the
   unchanged `user_id`, `handle`, and `created_at`; preserve any
   `display_name` / `avatar_url` / `last_active`. Set the new
   `key_version`.
8. `PUT` the new `profile.json` (unconditional). The mutex held
   since step 2 serializes the GET-VERIFY-WRITE sequence for this
   `user_id` — no conditional write is used; see
   [ops.md — Object storage constraints](../ops.md#object-storage-constraints).
9. Also write `handles/{handle}.json` (the resolve projection) with
   the new public fields.
10. Record the outcome under `users/{user_id}/rotation-records/{request_id}.json`
    (TTL 24h, swept by the cleanup routine).
11. Issue a new v2 bearer token to the rotating device, bound to the
    new `key_version`. Release the mutex.

The device record `users/{user_id}/devices/{device_id}.json` is **not
touched**. The rotating device keeps its `device_id` and existing
record — only its credential changes. Other devices' records are
also untouched; the cutoff is enforced via the token-version check,
not via record deletion. Those devices re-add themselves via
`POST /v1/devices` on next login.

The rotating client is responsible for writing the new entry into
`keys/{user_id}/key_chain.json` before issuing the rotation request
(see [Key chain](#key-chain)). The two writes are not transactional:
the client must complete the `key_chain.json` write first, then call
`rotate-keys`. If the `rotate-keys` call fails the orphaned chain
entry is harmless — it can't decrypt anything until a future
rotation appends a matching link.

Output:

- `token` (v2, bound to new `key_version`)
- `key_version` (echo of the new value)

### Resolve handle

`GET /v1/resolve/{handle}`

Three response states for v2 (custom-handle) accounts:

| Status | Meaning | Body |
|---|---|---|
| 200 | Handle is live | Full projection (see below) |
| 404 | Handle was never registered (or charset-invalid) | `{ "error": "not_found" }` |
| 410 | Handle is in 30-day cooldown after account deletion | `{ "released_at": "...", "available_at": "..." }` |

The 410 case is what makes the client's registration UI able to
distinguish "this handle is unavailable but coming back" from
"this handle was never used."

200 body (live handle):

- `user_id`
- `sharing_public_key`
- `salt` (needed for the login key derivation)
- `kdf` (`{ type, m, t, p }`)
- `key_version`
- `display_name` (if set)
- `avatar_url` (if set)

`salt`, `kdf`, and `key_version` are public per-user values: they are
not secrets, and senders ignore them. Only the account holder's
login flow consumes them.

The registration UI uses this endpoint debounced (~300 ms) for
real-time availability checking — no separate availability endpoint
exists.

### Send

`POST /v1/send`

Input:

- list of envelopes (addressed to users)

Server behavior:

- validate sender token
- verify `from_user` matches token's `user_id` and `from_device` matches token's `device_id`
- write each envelope to the addressed user's inbox prefix
- notify SSE subscribers for each recipient (`new_message`)

(v0.2 adds a best-effort Web Push fan-out to recipient devices here;
see [mvp-v0.2.md](mvp-v0.2.md).)

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

Deletes all per-user data: `users/{uid}/`, `inbox/{uid}/`,
`keys/{uid}/`, `media/{uid}/`. Token is implicitly invalidated.

The handle file `handles/{handle}.json` is **not deleted**. Instead,
the server rewrites it as a tombstone carrying only a `released_at`
timestamp:

```jsonc
{ "released_at": "2026-06-25T10:30:00Z" }
```

`GET /v1/resolve/{handle}` returns `410 Gone` until
`released_at + 30 days`. After that the cleanup routine sweeps the
tombstone, freeing the handle for re-registration. This prevents
immediate handle takeover (impersonation against the prior owner's
contacts) while keeping the namespace from growing indefinitely.

The cooldown is symmetric — the prior owner does not get
preferential re-claim during the 30 days. The server does not
remember who owned a handle after deletion. See
[ADR-0013](../decisions/adr-0013-user-chosen-handles.md).

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

### Materialization (chat-view assembly)

After sync writes decrypted envelopes to IDB, the chat-view
hook materializes the messages for display in a **two-pass walk**:

1. **First pass — partition.** Iterate the conversation's
   envelopes. Separate into originals (inner `type: "text"` or
   `"media"`) and amendments (inner `type: "amendment"`).
   Collect amendments into `Map<target_msg_id, Amendment[]>`,
   ordered by `msg_id` (chronological via ULID).
2. **Second pass — apply.** Walk the originals. For each, look
   up its amendment list and apply in order:
   - Verify each amendment's `from_user` equals the original's
     `from_user`. Mismatch → drop the amendment, log.
   - `action: "edit"` → replace the materialized body; tag with
     `edited_at` from the amendment.
   - `action: "delete"` → mark the materialized message as
     deleted; drop body and media references. Terminal — no
     further amendments are processed for this `target_msg_id`.
   - Unknown `action` → drop the amendment silently.
3. **Orphans.** Amendments whose `target_msg_id` is not yet in
   IDB are queued (kept in IDB with a "pending" flag) and
   re-attempted on each subsequent materialization. They land
   naturally as the original arrives via live sync, archive
   walk-back, or key-backup-driven decryption.

See [ADR-0014](../decisions/adr-0014-message-amendments.md).

Realtime hint:

- SSE connection (`GET /v1/events`) receives `new_message` events; client then syncs.

### New device sync

1. Resolve the user's salt + `kdf` + `key_version` via `GET /v1/resolve/{handle}`.
2. Derive keys from the entered password (Argon2id in a Web Worker, then HKDF).
3. If the account has rotated (i.e. `keys/{user_id}/key_chain.json`
   exists), fetch it and memoize the resolved older backup keys in
   IndexedDB.
4. Restore Megolm session keys from `keys/{user_id}/` (archive + live).
   For each blob, look at its `v` field; decrypt with the matching
   backup key (current or chain-derived).
5. Sync `inbox/{user_id}/live/` — most recent messages appear first.
6. Sync `inbox/{user_id}/archive/` in reverse date order — client walks backwards
   by constructing month prefixes (`archive/2025-06`, `archive/2025-05`, …).
   History fills in backwards.
7. Older archives can be fetched lazily (on scroll or in background).

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
- Amendments (edit/delete):
    - Alice sends "Hi Bob"; Bob sees it via SSE.
    - Alice edits to "Hello Bob". Bob's view updates to "Hello Bob"
      with an `(edited)` tag; the original "Hi Bob" is not visible
      in the chat view (chain stored, not displayed in v0.1).
    - Alice edits again to "Hey Bob". Bob sees "Hey Bob" with the
      `(edited)` tag carrying the latest amendment's `sent_at`.
    - Alice deletes the message. Bob's view shows `[deleted]` at
      the original position with the original timestamp. Further
      amendments after a delete have no visible effect.
    - Out-of-order: Bob is offline, Alice sends a message and
      immediately edits it. Bob comes online; Bob sees the edited
      body, no flicker of the original.
    - Self-copy: Alice's other device sees the same edit/delete
      state (amendment lands in her inbox too).
    - Media delete: Alice sends a photo, then deletes it. Bob's
      view shows `[deleted]`; a fresh browser context fetching
      `media/{alice}/{ulid}` gets 404; Bob's in-flight local
      blob cache is dropped.
    - Authorization: a synthetic amendment with `from_user`
      different from the original's sender is dropped by the
      materializer (test-only — no legitimate client path
      produces this).
