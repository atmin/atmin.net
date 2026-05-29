# ADR-0012: Backup-secret rotation

Status: Accepted
Date: 2026-05-25 (accepted 2026-05-29)

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
  "request_id":          "<UUID v4>",      // client-generated; idempotency key
  "key_version":          2,               // new version, must be current+1
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
string escapes, numbers in shortest round-tripping form). It is
essential here because the rotation request embeds a nested `kdf`
object and would be a footgun without a pinned canonicalization. The
auth proof now uses the same canonicalization, so there is a single
signing rule across both. We use `canonicalize` (npm) on the client
and `github.com/gowebpki/jcs` on the server.

The server flow:

1. Authenticate the bearer token (existing middleware).
2. **Acquire the per-`user_id` rotation mutex** (see *Concurrency
   control* below). If already held by another in-flight handler,
   block briefly with a short timeout; on timeout return
   `503 rotation_in_progress`.
3. Check the idempotency store: if this `request_id` has been
   processed before, replay its recorded outcome (token + key_version
   or error) without re-running the rotation. See *Idempotency*.
4. Read current `profile.json`.
5. Verify `request.key_version == profile.key_version + 1`. Reject
   `409 key_version_stale` otherwise.
6. Verify `continuity_signature` with the current
   `profile.auth_public_key`. Reject `403 bad_continuity` otherwise.
7. Build the new `profile.json` from the request fields plus the
   unchanged `user_id`, `handle`, `created_at`. Bump `key_version`.
8. Write `profile.json` (unconditional `PUT`). The mutex serializes
   any concurrent rotation handlers for this `user_id`, so the
   GET-VERIFY-WRITE sequence is effectively atomic. No conditional
   write is used; see [ops.md — Object storage constraints](../ops.md#object-storage-constraints).
9. Issue a new token bound to the new `key_version` (see *Token
   binding* below). Record the outcome under the `request_id` in
   the idempotency store. Release the mutex. Return the token.

The device record `users/{user_id}/devices/{device_id}.json` is
**not touched** by this flow. The rotating device keeps its existing
`device_id` and existing device entry — only its credential
(and therefore its key material and token) changes. Other devices'
records are also not touched server-side; they're cut off via the
token-version mechanism, not by deletion, and re-add themselves
via the normal add-device flow on re-login.

The endpoint is the only way to mutate `auth_public_key` or
`sharing_public_key` after registration.

### Concurrency control

The production object storage backend does not support request
preconditions (see
[ops.md — Object storage constraints](../ops.md#object-storage-constraints)),
so the GET-VERIFY-WRITE sequence on `profile.json` needs an
out-of-band serialization primitive.

For the current single-process server, that primitive is a Go
`sync.Map<user_id, *sync.Mutex>` in the rotation handler. The map
keeps the mutex alive only while a rotation is in flight; idle
entries are reclaimed by a periodic sweep. Two concurrent rotation
requests for the same `user_id` serialize on the mutex; only one
sees `kv=N` and writes `kv=N+1`. The other sees `kv=N+1` and
returns `409 key_version_stale`.

This pattern joins the existing in-process state on the server
(SSE hub, device-existence cache, profile-`key_version` cache,
media-quota cache). [ADR-0001](adr-0001-sync-first-s3-mailbox.md)
states "stateless by design," meaning S3 is the durable source of
truth — not that the server has no in-memory state. The mutex map
contains no durable information; on restart it's empty, which is
correct (no rotation is in flight after a restart).

**Multi-instance migration path.** If the server is later scaled
horizontally, the rotation mutex (along with the existing in-process
caches and the SSE hub) needs to move to shared state. A future
ADR will pick the substrate (Redis SETNX, Postgres advisory locks,
etc.) and migrate this work coherently. Until then, "single Go
process" is an explicit operational assumption.

**Degraded mode (shared state down).** When the system is later
multi-instance and the shared coordination store is unavailable,
rotation requests return `503 rotation_unavailable`. Messaging,
device add/revoke, and the rest of the system keep working —
rotation is the single operation that strictly needs strong
coordination. A "sign out other devices, wait T, then rotate"
degraded protocol was considered (see *Alternatives*) but its
correctness delta versus `503` is marginal and its complexity is
substantial, so the policy is hard-fail. The user is told *"can't
change your password right now, try again in a few minutes."*

### Idempotency

The continuity-signed rotation request body includes a
client-generated `request_id` UUID. The server records every
completed rotation outcome (`token` + `key_version` for success;
`error` + `status` for failure) under
`users/{user_id}/rotation-records/{request_id}.json`. The record's
TTL is bounded by a periodic cleanup (24 hours suffices — clients
that retry after a day get a fresh `request_id` anyway).

On every rotation request the handler first checks for an existing
record under the request's `request_id`. If present, the recorded
outcome is replayed verbatim. This dedups:

- The common network-retry case (client times out, retries with
  the same `request_id`, sees the same successful result instead
  of a `409 key_version_stale`).
- Genuinely-duplicated requests from buggy clients.

`request_id` is part of the JCS-canonicalized payload covered by
`continuity_signature`, so an attacker cannot forge an idempotent
replay by reusing a captured signed body — the recorded outcome
includes the *issued token*, and tokens are bound to the issuing
device's `device_id` (via the HMAC), so a replayed token wouldn't
help an attacker on a different device.

### `profile.json` schema

ADR-0011 added `salt` and `kdf`. This ADR adds a third field:

```jsonc
{
  "user_id": "...",
  "handle":  "...",
  "auth_public_key":    "...",
  "sharing_public_key": "...",
  "created_at": "...",

  // Added by ADR-0011 — always present
  "salt": "...",
  "kdf":  { "type": "argon2id", "m": 65536, "t": 3, "p": 1 },

  // Added by ADR-0012 — always present, starts at 1
  "key_version": 2
}
```

`handles/{handle}.json` (the resolve projection) gains `salt`, `kdf`,
and `key_version` so any device's login flow has everything it needs
in one round trip.

### Token binding

Token format gains a `key_version` segment, and the HMAC covers it:

```
token = base64url(
    user_id || "." ||
    device_id || "." ||
    key_version || "." ||
    HMAC-SHA256(server_secret, user_id || "." || device_id || "." || key_version)
)
```

The legacy three-segment token (no version segment) is rejected. The
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

Auth-proof payloads are signed over their JCS-canonicalized form,
matching the rotation request — a single signing rule. A payload
without `key_version` (the legacy non-canonical shape) is rejected.
Server rejects a proof whose `key_version` does not match the current
`profile.key_version`.

### Multi-device propagation: immediate cutoff

The combination of token binding and auth-proof binding produces a
hard cutoff at the moment the new `profile.json` is written:

- Every other device holds a token bound to the old `key_version`.
  Its next request returns `401 key_version_stale`.
- The client treats this as a forced sign-out: clear IndexedDB,
  clear `localStorage`, navigate to the login screen with a one-line
  notice ("This account was rotated on another device — please sign
  in again"). User re-types the new credential, the login flow runs
  Argon2id with the new `salt`/`kdf`, the device re-adds itself via
  `POST /v1/devices` with an auth proof at the new `key_version`.
- The rotating device receives its new token in the rotation
  response and keeps operating.

No grace period. No partial trust. The compromised credential
trajectory ("attacker has the old password, user rotates, attacker's
session is dead immediately") is the same trajectory as the routine
"change my password" case.

### Backup migration (lazy)

Two changes:

**0. Backup-key extractability.** ADR-0011 establishes backup keys
as non-extractable AES-256-GCM `CryptoKey`s — XSS during a session
can encrypt/decrypt with them but cannot exfiltrate the raw bytes.
The chain mechanism below requires wrapping the *old* backup key
with the *new* one, which requires a raw export. Resolution:
backup keys remain non-extractable in the normal `deriveKeys` path.
The rotation flow calls a variant (`deriveKeys({ extractable: true })`)
to re-derive *only* the old backup key from the user's freshly
re-entered current password, computes the chain link, and discards
the extractable copy. The persisted at-rest backup key is never
extractable. XSS at the moment of rotation could exfiltrate the
temporarily-extractable key for the rotation window only — narrow
and already covered by the larger "credential being entered" threat.

**1. Envelope versioning.** All client-encrypted blobs (key backups
under `keys/{uid}/live/...` and `keys/{uid}/archive/...`, and
`users/{uid}/contacts.json`) switch to an outer envelope:

```jsonc
{ "v": 2, "iv": "...", "ciphertext": "..." }
```

Every blob written carries `v`; on read, a missing `v` is defensively
coerced to `v: 1` so a stray pre-versioning blob stays readable (key
blobs are write-once — neither rotation nor compaction rewrites them).
The server is content-agnostic so no server change; only the client
schema moves.
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
every 100 messages anyway; rotation just forces it sooner.

### Contact sharing-key refresh

A contact (Bob) who has a chat with the rotating user (Alice) needs
Alice's *current* `sharing_public_key` whenever he encrypts a new
Megolm session key for her via ECIES. After Alice rotates, any key
share Bob builds against a stale snapshot of her sharing key would
be ECIES-decryptable only with Alice's old sharing private key —
which her rotated device has discarded.

**Policy: clients re-resolve the recipient's profile on every send,
not just on chat-open.** The `sharing_public_key` returned by
`GET /v1/resolve/{handle}` is used directly to build the ECIES
ciphertext, with no client-side caching of that field. One additional
GET per outgoing message is a tolerable cost given the simplicity
guarantee it buys (no stale-key window after rotation, no
sender-receiver re-handshake protocol).

Bob's *existing* outbound session for Alice is unaffected by her
rotation — its key share was already delivered, and Alice cached the
decrypted session key in her IDB pre-rotation. New messages in that
session continue to decrypt with that cached entry. Only the *next*
Megolm session Bob creates (after his own session restarts every 100
messages or on app boot) needs to encrypt a fresh key share, and the
per-send resolve guarantees it picks up Alice's new sharing key.

On resolve failure (network unreachable), the client surfaces the
send error and lets the user retry; no fallback to a cached sharing
key — silently encrypting to a possibly-stale key would produce
undecryptable messages with no diagnostic.

Receiver-side back-signaling — "I couldn't ECIES-decrypt your key
share, here's my current sharing key" — was considered as an
alternative. Rejected: it doubles the wire-format surface (new
envelope type, sender-side retry logic) to optimise away a single
GET on a path that is already an HTTPS round trip. Reconsider if
profile-resolve latency becomes a measured problem.

### Error model

Three new error codes:

- `401 key_version_stale` — token or auth proof bound to a
  superseded `key_version`. Response body includes `{ "current": N }`
  so clients can render an informative re-login screen.
- `403 bad_continuity` — `continuity_signature` does not verify
  against the current `profile.auth_public_key`. Distinct from
  `401`: this is malicious or buggy, not stale.
- `503 rotation_unavailable` — multi-instance only, when the shared
  coordination store is unreachable. Single-instance deployments
  never emit this. Body: `{ "retry_after_seconds": N }`.

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
- Archive CBOR arrays may now contain mixed-version entries when a
  rotation lands between compactions. The compaction server flow is
  unchanged — entries remain opaque to the server — but the client
  decryption pass has to dispatch per-entry on `v`. Independently
  cheap; just an extra dispatch step.
- Concurrency on `profile.json` writes relies on an in-process
  per-`user_id` mutex (see *Concurrency control* above and
  [ops.md — Object storage constraints](../ops.md#object-storage-constraints)).
  This pins single-instance deployment as an explicit operational
  assumption; multi-instance migration is a future ADR.
- Two new small dependencies are required for JCS canonicalization:
  `canonicalize` (npm, ~1 KB) on the client and
  `github.com/gowebpki/jcs` on the server. Both are narrow,
  single-purpose libraries with no transitive surface to speak of.
- Idempotency records (`users/{uid}/rotation-records/{request_id}.json`)
  add a tiny per-rotation storage cost (~200 bytes) with a 24h TTL.
  Negligible.

### Neutral

- The `salt` rotates along with the secret. This is automatic —
  the rotating device generates a fresh 16-byte salt as part of
  preparing the new key material. Reusing the old salt would be
  cryptographically fine, but rotating it is simpler to reason
  about and costs nothing.
- The dual-path code (legacy and current tokens / auth proofs / blob
  envelopes) was retained for a time as a rehearsal of how future
  protocol upgrades roll out, then removed once every account had
  migrated — leaving a single wire shape for each.
- `key_chain.json` is itself encrypted only by the current backup
  key; the file's existence reveals that a rotation occurred, but
  not how many times, what the previous parameters were, or
  anything about the credentials.

## Alternatives considered

### Conditional writes with `If-Match` (the original design)

Rejected because the production object storage backend does not
support request preconditions (see
[ops.md — Object storage constraints](../ops.md#object-storage-constraints)).
The in-process mutex pattern serves the same role at the cost of
pinning single-instance operation as an explicit assumption.

### "Sign out other devices, wait T, then rotate" (degraded-mode protocol)

Considered for shared-state-unavailable scenarios in a future
multi-instance deployment. The protocol closes most of the same
race windows the mutex closes — the user revokes their other
devices, waits `T = T_cache_TTL + T_proc_max` (~30–60 s) for any
in-flight requests to settle, then submits the rotation with a
server-signed `rotation_after` token.

Rejected for v0.1 because:

- It doesn't close the active-attacker-with-current-credentials
  race, which the in-process mutex doesn't close either — so the
  correctness delta versus a hard `503` is small.
- It doubles the rotation surface (two protocols, two UX flows,
  two test matrices, and the compose-during-shared-state-flap
  case).
- v0.1 is single-instance, so the question is hypothetical until
  multi-instance lands.

Pinned here so future-us can pick it up coherently if shared-state
outages become a real concern after multi-instance scaling.

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
