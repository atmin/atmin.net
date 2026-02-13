# ADR-0002: ECIES key sharing, no Olm

Status: Accepted
Date: 2026-02-11

## Context

Megolm session keys must be delivered to recipients before they can decrypt messages.
The standard Matrix approach uses Olm (Double Ratchet) for this: each pair of devices
maintains an Olm session, and session keys are encrypted per-device.

Our system uses a **user-level static sharing key** (X25519), derived from the backup secret.
All of a user's devices share the same private key. This means:

- There is no concept of per-device key exchange.
- Senders encrypt to the user, not to individual devices.
- New devices can decrypt old key shares without migration.

The question is whether Olm adds value in this model.

## Decision

Use **ECIES** (ephemeral X25519 + HKDF-SHA256 + AES-256-GCM) for key sharing. No Olm.

Each key share is a one-shot encryption:

1. Generate ephemeral X25519 keypair.
2. ECDH: `shared = ephemeral_private × recipient_sharing_public`.
3. `key = HKDF-SHA256(ikm=shared, salt="", info="atmin.net key share", L=32)`.
4. `ciphertext = AES-256-GCM(key, session_key_bytes)`.

The ephemeral public key, IV, and ciphertext are delivered as a regular envelope.

## Consequences

### Positive

- No session management between devices. No pre-key bundles, no session state,
  no "unknown session" errors.
- Sender needs only the recipient's public key (from their profile). No device enumeration.
- New devices decrypt old key shares from the inbox — the sharing private key is the same.
- ECIES is simple, well-understood, and implemented entirely in Web Crypto API (no WASM).
- One fewer WASM dependency (Olm would require vodozemac Olm bindings in addition to Megolm).

### Negative

- **No per-message forward secrecy at the key exchange layer.** If the sharing private key
  is compromised, all past and future key shares are decryptable.
  However: the sharing private key is derived from the backup secret. If the backup secret
  leaks, the attacker also has the backup encryption key (can read key backups) and the
  auth key (can add rogue devices). Olm's forward secrecy would not help in this scenario.
- **No key exchange ratchet.** The sharing key is static for the lifetime of the backup secret.
  Olm would rotate the shared secret on every exchange. In practice, Megolm already provides
  forward secrecy within each session (ratcheting message keys), and sessions rotate every
  100 messages or on app start.

### Neutral

- If per-message forward secrecy at the key exchange layer becomes important (e.g. for
  high-risk users), a ratcheting protocol could be layered on top without changing the
  envelope format. The `content_type` field allows new key exchange mechanisms alongside
  the existing one.

## Alternatives considered

### Olm (Double Ratchet)

Rejected. Olm assumes per-device sessions. Our user-level sharing key makes device-to-device
sessions unnecessary. Olm's forward secrecy provides no additional protection when the
sharing key compromise implies full backup secret compromise.

### Static ECDH (no ephemeral key)

Rejected. Without an ephemeral keypair, all key shares to the same recipient would use the
same shared secret — no ciphertext independence. ECIES provides a fresh shared secret per
key share via the ephemeral keypair.
