# ADR-0008: P-256 for the static sharing keypair

Status: Accepted
Date: 2026-04-13

Amends ADR-0002 (ECIES-not-Olm) on curve choice only. The ECIES framing is unchanged.

## Context

The static sharing keypair introduced in ADR-0002 was originally X25519. On
iOS WebKit (Safari and iOS Firefox, which shares the same engine) we found
that X25519 `CryptoKey` objects structured-clone *into* IndexedDB on `put`
but deserialize as `undefined` on `get`. The record is physically present
in the object store — `count` reports it — but `IDBObjectStore.get` returns
`undefined`. AES-GCM and other algorithms round-trip fine on the same browser.
Desktop Chrome/Firefox/Safari are unaffected.

The effect: every page refresh on iPhone lost the sharing private key half
of the session and logged the user out, even though the auth token in
localStorage was still valid (and the server-side session record intact —
revoke/list on "Devices" kept working).

A separate concern surfaced during the investigation: the sharing private
key was `extractable: true`, because the derivation path used
`exportKey('jwk', ...)` to recover the public coordinate. Any same-origin
script (XSS, compromised dependency) could therefore copy the private key
material off the device in a single call, and the compromise would be
permanent.

## Decision

Use **ECDH on NIST P-256** for the static sharing keypair and for the ECIES
ephemeral keypair. Store the sharing private key as a non-extractable
`CryptoKey` (`extractable: false`). Compute the P-256 public point from the
HKDF-derived scalar using `@noble/curves` at import time — Web Crypto's
ECDH JWK import requires `x`, `y`, and `d`, and does not compute the public
point from `d` alone.

Wire format changes:

- `profile.sharing_public_key`: 65 bytes (uncompressed SEC1, `0x04 || X || Y`)
  instead of 32 bytes (X25519).
- `key_share.payload.ephemeral_key`: 65 bytes uncompressed SEC1.
- `profile.crypto_version` bumped accordingly.

ECIES envelope structure, HKDF parameters, and AES-GCM parameters are
unchanged.

## Consequences

### Positive

- iOS WebKit IDB round-trip for the sharing key works. The split-storage
  session (localStorage + IndexedDB) survives page refresh on iPhone.
- The sharing private key is no longer exfiltrable by same-origin JS. XSS
  during a live session can still *use* the key (`deriveBits`) to decrypt
  traffic observed while the script is resident, but cannot copy the scalar
  off the device. Compromise is bounded in time, not permanent.
- Web Crypto support for P-256 ECDH is universal and has been stable for
  ~a decade, removing a platform-support variable.

### Negative

- One new runtime dependency: `@noble/curves` (~6 KB, audited). Only used
  during key derivation to compute the public point from the seed scalar.
- The ECIES shared secret is the P-256 x-coordinate (still 32 bytes and
  HKDF-processed, so the security argument is unchanged) rather than the
  Curve25519 scalar product. NIST curves carry more footguns than
  Curve25519 in general, but ECDH in this specific usage (ephemeral-static
  with HKDF) is not sensitive to them.
- Envelopes and profiles grow by ~33 bytes each. Negligible.

### Neutral

- The sharing seed must be a valid P-256 scalar (`1 <= d < n`). The
  probability of the HKDF output falling outside this range is ~2^-128.
  The derivation path checks and throws if it happens; no rejection
  sampling is implemented because the event is not reachable in practice.
- Backup-secret derivation is unchanged (`HKDF(info="sharing-v1")`). New
  devices re-derive the same P-256 scalar and therefore the same keypair.

## Migration

Clean break. v0.1 is pre-launch; no production data. Existing local
sessions and any in-flight key shares become undecryptable after this
change and must be recreated by re-registering. No dual-curve code path
is introduced. If a future change needs a curve transition after launch,
it will have to be versioned through the envelope's `v` field or a new
`content_type`.

## Alternatives considered

### Keep X25519, work around the iOS bug by storing seed bytes

Rejected. Storing the 32-byte seed in localStorage and re-importing the
`CryptoKey` on each load would fix the round-trip, but the key would still
be effectively extractable (the seed is in JS-readable storage). It would
also leave the program relying on a WebKit code path we already know is
broken, with no defense if a similar bug surfaces for a different
algorithm later.

### WebAuthn PRF-derived keys

Deferred. PRF gives hardware-backed key material that JS never touches,
which is materially stronger than non-extractable CryptoKey. Cost is a
biometric tap per session and a new recovery story. Worth doing as a
future hardening pass; out of scope for unblocking iPhone.

### Native app (Capacitor + iOS Keychain)

Deferred. Strongest option on iOS (Secure Enclave), but justified by
product features (address-book discovery, push, App Store distribution),
not by the storage bug alone.

### Generate keys non-deterministically (drop backup-secret derivation)

Rejected. Deterministic derivation from the backup secret is a
load-bearing property — it lets new devices and recovery flows reconstruct
the same keypair from the mnemonic without server state. Giving that up
would force server-side ciphertext-or-keypair storage and reshape the
trust model.
