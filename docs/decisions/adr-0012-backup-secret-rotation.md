# ADR-0012: Backup-secret rotation

Status: Draft
Date: 2026-05-25

Builds on [ADR-0011](adr-0011-credential-derivation.md). Promotes the
"Backup secret rotation" section of
[docs/evolution/device-revocation.md](../evolution/device-revocation.md)
into the spec of record. The line in
[docs/specs/mvp-v0.1.md](../specs/mvp-v0.1.md) stating that rotation is
deferred is superseded.

## Context

ADR-0011 introduced Argon2id-derived credentials but said nothing
about how an existing account swaps its credential. Without rotation
there is no meaningful "change password" UX: a user who wants to
change credentials, or who suspects compromise, has to abandon the
account and re-register under a new handle. All historical
conversation context is lost.

Rotation has to do four things atomically from the user's
perspective:

1. Replace the auth, sharing, and backup keys with values derived
   from the new credential.
2. Re-publish the new public keys to `profile.json` such that all
   prior public-key material is no longer authoritative.
3. Eject every other device on the account, immediately, so a stolen
   credential or compromised device cannot keep operating once the
   rightful user has rotated.
4. Preserve the user's existing data — Megolm session-key backups
   and the contact list — without making the rotating device
   re-encrypt everything synchronously.

The cryptographic identity is rooted in a 16-byte secret. Anything
derived from it (Ed25519 auth keypair, P-256 sharing keypair,
AES-256-GCM backup key) is fully recomputable from the secret, so
rotation reduces to: get a new secret, prove continuity, atomically
publish, propagate.

## Decision

### Continuity-signed rotation

A new endpoint `POST /v1/rotate-keys` accepts:

```jsonc
{
  "key_version": 2,                        // new version, must be current+1
  "auth_public_key":     "<base64url>",    // Ed25519, derived from new secret
  "sharing_public_key":  "<base64url>",    // P-256, derived from new secret
  "salt":                "<base64url>",    // new 16-byte Argon2id salt
  "kdf":                 { "type": "argon2id", "m": 65536, "t": 3, "p": 1 },
  "continuity_signature":"<base64url>"     // see below
}
```

The `continuity_signature` is an Ed25519 signature over the
**JCS-canonicalized** ([RFC 8785](https://www.rfc-editor.org/rfc/rfc8785))
form of the request body excluding the `continuity_signature` field
itself, produced by the **old** auth private key. Server verifies
the signature against the **current** `profile.auth_public_key`
before writing.

JCS pins a deterministic byte sequence for any JSON value
(recursive lexicographic key ordering, no whitespace, RFC 8259
string escapes, numbers in shortest round-tripping form). This
matters more here than it did for the v1 auth proof — the v1
payload is a flat three-string object where `JSON.stringify` happens
to be deterministic in practice, but the rotation request embeds a
nested `kdf` object and would be a footgun without a pinned
canonicalization. We use `canonicalize` (npm) on the client and
`github.com/gowebpki/jcs` on the server.

The server flow:

1. Authenticate the bearer token (existing middleware).
2. Read current `profile.json` along with its ETag.
3. Verify `request.key_version == profile.key_version + 1`. Reject
   `409 key_version_stale` otherwise.
4. Verify `continuity_signature` with the current
   `profile.auth_public_key`. Reject `403 bad_continuity` otherwise.
5. Build the new `profile.json` from the request fields plus the
   unchanged `user_id`, `handle`, `created_at`. Bump `key_version`.
6. `PUT` it to S3 with `If-Match: <prior ETag>`. On `412`, return
   `409 key_version_stale` — another device just rotated.
7. Issue a new token bound to the new `key_version` (see *Token
   binding* below). Return it in the response.

The device record `users/{user_id}/devices/{device_id}.json` is
**not touched** by this flow. The rotating device keeps its existing
`device_id` and existing device entry — only its credential
(and therefore its key material and token) changes. Other devices'
records are also not touched server-side; they're cut off via the
token-version mechanism, not by deletion, and re-add themselves
via the normal add-device flow on re-login.

The endpoint is the only way to mutate `auth_public_key` or
`sharing_public_key` after registration.

### `profile.json` schema

ADR-0011 added `salt` and `kdf` (absent for v1 accounts). This ADR
adds a third additive field:

```jsonc
{
  "user_id": "...",
  "handle":  "...",
  "auth_public_key":    "...",
  "sharing_public_key": "...",
  "created_at": "...",

  // Added by ADR-0011 — absent for legacy accounts
  "salt": "...",
  "kdf":  { "type": "argon2id", "m": 65536, "t": 3, "p": 1 },

  // Added by ADR-0012 — absent = 1
  "key_version": 2
}
```

`handles/{handle}.json` (the resolve projection) gains `salt`, `kdf`,
and `key_version` so any device's login flow has everything it needs
in one round trip.

### Token binding

Token format gains a `key_version` segment, and the HMAC covers it:

```
v2 token = base64url(
    user_id || "." ||
    device_id || "." ||
    key_version || "." ||
    HMAC-SHA256(server_secret, user_id || "." || device_id || "." || key_version)
)
```

v1 tokens (no version segment) are treated as `key_version = 1`. The
auth middleware compares the token's `key_version` to the current
`profile.key_version`. Mismatch → `401 key_version_stale`, with the
current version in the response body so the client can show the
right UX ("re-enter your password").

### Auth-proof binding

The auth-proof payload signed for add-device and revoke-device gains
`key_version`:

```jsonc
{ "user_id": "...", "device_id": "...", "timestamp": "...", "key_version": 2 }
```

v2 auth-proof payloads are signed over their JCS-canonicalized form,
matching the rotation request. v1 payloads (no `key_version` field)
continue to use the existing `JSON.stringify` path for verification
compatibility, since v1 is frozen and not regenerated. Missing
`key_version` is treated as `1`. Server rejects a proof whose
`key_version` does not match the current `profile.key_version`.

### Multi-device propagation: immediate cutoff

The combination of token binding and auth-proof binding produces a
hard cutoff at the moment the new `profile.json` is written:

- Every other device holds a v1-or-older token. Its next request
  returns `401 key_version_stale`.
- The client treats this as a forced sign-out: clear IndexedDB,
  clear `localStorage`, navigate to the login screen with a one-line
  notice ("This account was rotated on another device — please sign
  in again"). User re-types the new credential, the login flow runs
  Argon2id with the new `salt`/`kdf`, the device re-adds itself via
  `POST /v1/devices` with a v2 auth proof.
- The rotating device receives its new token in the rotation
  response and keeps operating.

No grace period. No partial trust. The compromised credential
trajectory ("attacker has the old password, user rotates, attacker's
session is dead immediately") is the same trajectory as the routine
"change my password" case.

### Backup migration (lazy)

Two changes:

**1. Envelope versioning.** All client-encrypted blobs (key backups
under `keys/{uid}/live/...` and `keys/{uid}/archive/...`, and
`users/{uid}/contacts.json`) switch to an outer envelope:

```jsonc
{ "v": 2, "iv": "...", "ciphertext": "..." }
```

A blob without `v` is treated as `v: 1` (legacy). The server is
content-agnostic so no server change; only the client schema moves.
Compaction must produce homogeneous archives — never mix versions in
the same archive blob.

**2. Key chain.** A new file `keys/{uid}/key_chain.json` carries the
historical backup keys, each wrapped by the next-newer one:

```jsonc
{
  "links": [
    { "from": 1, "to": 2, "iv": "...", "ciphertext": "..." }
    // ...one link appended per rotation
  ]
}
```

`ciphertext` is `AES-256-GCM(backup_key_v2, backup_key_v1)` — the
older backup key encrypted by the newer. The rotating device writes
this link as part of the rotation flow (it has both keys at that
moment). On read of a blob with `v: N` where `N < current`, the
client walks the chain backwards from `current` to `N`, decrypting
each link to recover `backup_key_N`, then decrypts the blob.

New writes always use the current backup key. No background
re-encrypt job. Pathological "rotate 100 times" makes legacy reads
slow but does not break anything.

### Megolm session restart

The rotating device throws away its current outbound Megolm session
and starts a fresh one on next send. Per [adr-0002] this happens
every 100 messages anyway; rotation just forces it sooner. Contacts
fetch the new `sharing_public_key` next time they refresh the
rotating user's profile, and the new key share is encrypted to that
fresh sharing key. No explicit signal needed.

### Error model

Two new error codes:

- `401 key_version_stale` — token or auth proof bound to a
  superseded `key_version`. Response body includes `{ "current": N }`
  so clients can render an informative re-login screen.
- `403 bad_continuity` — `continuity_signature` does not verify
  against the current `profile.auth_public_key`. Distinct from
  `401`: this is malicious or buggy, not stale.

Existing `409` semantics are reused for the `key_version` precondition
on the rotation request itself.

## Consequences

### Positive

- "Change password" is a real, atomic, secure operation.
- Compromised credentials can be ejected without losing the account
  or any historical conversation state.
- Cutoff is enforced at the protocol level — server doesn't need a
  per-device revocation list, and clients can't accidentally keep
  using stale keys past rotation.
- Backup migration is lazy: rotation latency is bounded by one
  `profile.json` write plus one `key_chain.json` write, regardless
  of how many key-backup blobs the user has.
- Token-version binding means a stolen token from before rotation
  is dead on the next request, with no need for a server-side
  revocation cache to track it.
- Per-rotation params (carried on `profile.json`) mean each rotation
  can adopt stronger Argon2id parameters than the previous one.

### Negative

- Every other device pays one full re-login per rotation.
  Acceptable, but worth surfacing in the UI so users aren't
  surprised. ("You will need to sign in again on your other devices.")
- Backup-blob reads after N rotations cost N key-chain decryptions.
  Memoize the resolved backup keys in IDB to amortize.
- Token and auth-proof formats now have two wire versions in
  circulation. Code paths must handle both until legacy sunset.
- Compaction has to be version-aware. The current compaction code
  iterates `keys/{uid}/live/*` and writes a single archive blob; it
  now needs to bucket by version and write one archive per bucket
  (or skip rotation-spanning compactions and let the next pass
  catch them).
- ETag-conditional `profile.json` writes assume the S3-compatible
  backend supports `If-Match`. MinIO does; production target
  (Scaleway) does. Verifying this in the test matrix is a
  prerequisite to Task B.
- Two new small dependencies are required for JCS canonicalization:
  `canonicalize` (npm, ~1 KB) on the client and
  `github.com/gowebpki/jcs` on the server. Both are narrow,
  single-purpose libraries with no transitive surface to speak of.

### Neutral

- The `salt` rotates along with the secret. This is automatic —
  the rotating device generates a fresh 16-byte salt as part of
  preparing the new key material. Reusing the old salt would be
  cryptographically fine, but rotating it is simpler to reason
  about and costs nothing.
- The dual-path code (v1 and v2 tokens / auth proofs / blob
  envelopes) is retained deliberately as a rehearsal of how future
  protocol upgrades will roll out. Sunset is expected within weeks
  of launch but is not pinned here.
- `key_chain.json` is itself encrypted only by the current backup
  key; the file's existence reveals that a rotation occurred, but
  not how many times, what the previous parameters were, or
  anything about the credentials.

## Alternatives considered

### Graceful grace-period rotation (α)

Rejected. Letting old tokens and old auth proofs continue to work
for N hours after rotation lowers UX friction but creates a window
where a rotated-out credential is still partially trusted. The
"change my password because I think it was compromised" use case
becomes meaningless during that window. The simplicity of the
immediate-cutoff model — token and auth proof both gate on
`key_version`, mismatch is `401`, end of story — outweighs the UX
cost of a forced re-login on other devices.

### No multi-device cutoff (other devices keep working with cached
keys until they hit a 401 naturally)

Rejected. Without explicit cutoff, other devices can keep decrypting
and sending messages indefinitely on the basis of cached old keys.
This defeats the security purpose of rotation. The token-binding
mechanism is the cheapest possible enforcement.

### Server stores history of public keys; validates against any past
version

Rejected. Server-side key history makes rotation reversible
("attacker rotates back to a key they control"), forces the server
to reason about which key_version is currently authoritative for a
given operation, and adds storage that has zero legitimate read
path. The chosen design keeps `profile.json` as a single
authoritative state at all times.

### Eager re-encrypt all key backups on rotation

Rejected. A user with 10k Megolm session-key backups would face a
multi-minute rotation flow that has to hold both the old and new
backup keys in memory while it re-encrypts everything. Lazy
migration via `key_chain.json` is `O(rotations)` per read of an old
blob, in exchange for `O(1)` rotation cost.

### Drop old key backups on rotation

Rejected. The point of key backups is so a new device can decrypt
historical messages. Dropping them on rotation defeats that. The
chain mechanism preserves access for the legitimate cost of a few
extra HKDF/AES operations per read.

### Filename-encoded versioning (`keys/{uid}/live/v2/{session_id}`)

Rejected. Changes the storage path layout, breaks the existing
`authorizeKey` prefix rules in `server/handlers.go`, and complicates
sync logic that walks `keys/{uid}/live/*`. The envelope-versioning
approach keeps paths stable and pushes the schema change to the
content layer where the client already does encryption work.
