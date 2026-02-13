# Evolution notes

This document captures likely future evolution paths of the system.
It is **not a roadmap or a commitment**.

The purpose is to preserve context, design intent, and known trade-offs,
so future changes do not require rediscovering the same discussions.

---

## Real-time delivery (optional optimization)

- v0.1 treats realtime delivery as a best-effort optimization.
- Sync from storage is the authoritative delivery mechanism.
- Future improvements may include:
  - WebSocket-based "new mail" hints,
  - cross-instance fanout via a shared pub/sub layer.

These optimizations must not become correctness dependencies.

---

## Discovery and identity (deferred)

- v0.1 uses invite-based discovery only.
- No phone numbers, email addresses, or address book access are required.
- Invite handles are resolved via S3 lookup objects (`invites/{handle}.json`).

Future directions (opt-in, undecided):
- Public identifier discovery (e.g. verified phone numbers).
- Privacy-preserving contact matching.
- Additional identity claims layered on top of the existing model.

When discovery needs grow beyond S3 GET lookups, a cache layer (e.g. Redis) can be
introduced. S3 remains the source of truth; the cache is reconstructable by scanning
S3 prefixes (`invites/`, `users/`, `discovery/`). Cache loss causes discovery downtime,
not data loss. Index objects follow a convention:

- `invites/{invite_handle}.json` — invite lookup (v0.1)
- `discovery/phone/{hash}.json` — phone lookup (v0.2+, opt-in)
- `discovery/username/{name}.json` — username lookup (v0.2+, opt-in)

---

## Usernames (invite handles → stable identifiers)

- v0.1 invite handles are two BIP39 words (e.g. `copper-falcon`), server-generated.
- If users could choose their handle (with uniqueness enforcement), handles become usernames.
- The resolve infrastructure (`invites/{handle}.json` → user_id) already supports this.
- A user could claim multiple handles (aliases).
- Only addition needed: a "claim handle" API with uniqueness check.

---

## Email gateway

If handles are stable identifiers, `{handle}@atmin.net` becomes a valid email address.
The gateway is just another writer using the public API.

**Plaintext email** (standard SMTP):

1. Receive email at `{handle}@atmin.net`.
2. Resolve handle → user_id + sharing_public_key.
3. Gateway encrypts the email body with the recipient's sharing key.
4. Deliver via `POST /v1/send` with `content_type: gateway.email`.

Gateway sees plaintext — inherent to email, not a new compromise.

**PGP-encrypted email** (true E2E):

The sharing key is Curve25519, which PGP supports. It can be published as a PGP
public key via WKD (Web Key Directory) at `atmin.net`.

1. External sender encrypts email with Alice's PGP key (= sharing public key).
2. Gateway receives PGP ciphertext — **cannot read it**.
3. Gateway wraps the opaque ciphertext in an envelope with `content_type: gateway.pgp_email`.
4. Delivers to inbox as-is. No Megolm needed — PGP already provides E2E.
5. Alice's client decrypts with her sharing private key.

The sharing key does double duty: Megolm key shares from atmin.net users,
and PGP encryption from external senders. Same key, two protocols.

---

## Threads / topics (client-side conversations)

- v0.1 has no server-side concept of "conversations."
  Clients materialize chats by grouping messages by `from_user`.
- Multiple conversations between the same pair of users (e.g. per topic)
  can be supported by adding a `thread_id` inside the encrypted payload.
- Client groups by `(from_user, thread_id)` instead of just `from_user`.
- Zero server changes — pure client-side concept.
- Fits the "client-side intelligence over server-side state" principle.

---

## Device revocation and key rotation

v0.1 includes token revocation (see [spec](./specs/mvp-v0.1.md#revoke-device)).
This section covers defense-in-depth measures beyond token revocation.

### Backup secret rotation

Token revocation stops API access, but the attacker still holds cryptographic keys.
If the attacker later regains access (server bug, server compromise), those keys
become dangerous again. Key rotation eliminates this residual risk:

1. **Generate new backup secret** on a surviving device → new auth, sharing, backup keys.
2. **Prove continuity** — sign the new public keys with the old auth key.
   Server verifies both signatures, updates `profile.json`.
3. **Re-encrypt key backups** — decrypt with old backup key, re-encrypt with new one.
   Can be lazy: new sessions use new key immediately, old backups migrate in background.
4. **Contacts pick up new sharing key** — next time they fetch the profile,
   new key shares use the new key. No explicit notification.
5. **Force Megolm session rotation** — surviving devices create new sessions.

**What rotation protects**: all future key shares, key backups, messages, and device additions.

**What's permanently exposed**: messages and keys the attacker already downloaded.
This is unavoidable in any system where keys must be on-device.

Server changes: rotate-keys endpoint, `key_version` in `profile.json`.
All additive — no structural changes.

### App-level key protection (optional hardening)

Local key material can be gated behind:

- **App passphrase** — encrypt IndexedDB keys at rest, require passphrase on app open.
  Protects against casual physical access. UX cost: passphrase entry on every launch.
- **WebAuthn / biometrics** — use platform authenticator to gate key release.
  Better UX than passphrase, but browser support varies.

Neither replaces OS-level device lock, but both add defense-in-depth.

---

## Large media (chunked encryption + streaming playback)

v0.1 encrypts files as a single AES-256-GCM blob. This works for photos and small files
but breaks down at ~100MB+: `crypto.subtle.encrypt` is not streaming (entire plaintext +
ciphertext in memory), upload can't resume on failure, and playback requires full download.

**Chunked encryption** solves all three:

1. Split file into fixed-size chunks (e.g. 5MB).
2. Encrypt each: `AES-256-GCM(key, nonce = base_iv || uint32(chunk_index), chunk)`.
3. Upload via S3 multipart upload — one encrypted chunk per part. Failed part = retry that part.
4. Final S3 object is a single blob of concatenated encrypted chunks.

Each encrypted chunk is `chunk_size + 16` bytes (GCM auth tag).

**Streaming playback**: recipient fetches via HTTP Range requests aligned to
encrypted chunk boundaries, decrypts chunk-by-chunk, feeds to MediaSource Extensions (MSE).
Playback starts after the first chunk.

**Message format** is forward-compatible — presence of `chunk_size` signals chunked mode:

```json
{
  "type": "media",
  "body": "video.mp4",
  "file": {
    "url": "media/alice01/<sha256>/video.mp4",
    "key": "<base64 AES-256-GCM key>",
    "base_iv": "<base64 8-byte>",
    "chunk_size": 5242880,
    "size": 1073741824,
    "sha256": "<hex of plaintext>"
  }
}
```

Absence of `chunk_size` = single-blob mode (v0.1 path). No migration needed.

---

## Guiding principle

Evolution should favor:
- additive changes over breaking rewrites,
- client-side intelligence over server-side state,
- simple failure modes over complex coordination.

If a change requires centralized state, it must be clearly justified
and documented via an ADR.
