# ADR-0011: Argon2id credential derivation

Status: Draft
Date: 2026-05-25

## Context

The current credential model is a 128-bit `backup_secret` encoded as a
12-word BIP39 mnemonic. HKDF-SHA256 over that secret derives the auth
Ed25519, sharing P-256, and backup AES-256-GCM keys
([adr-0002](adr-0002-ecies-not-olm.md), [adr-0008](adr-0008-p256-sharing-keypair.md)).
The mnemonic encoding guarantees uniform 128-bit entropy in the input
to HKDF, so direct HKDF is safe — HKDF *expands*, it does not *stretch*.

This breaks the moment we let a user pick a password. A typed
`letmein` carries ~10 bits of entropy. Running it through HKDF
preserves that 10 bits across the auth keypair, sharing keypair, and
backup key. The auth public key is published on `profile.json`, so the
attacker has a public verifier they can run brute-force against
offline. The whole account collapses on a dictionary attack.

To support a "change password" UX where the credential is a
user-typed string with a strength meter, the credential must pass
through a memory-hard stretching KDF *before* HKDF. The decision is
which KDF, which parameters, where the salt lives, and how the
existing BIP39-rooted accounts coexist with the new path.

## Decision

### Algorithm

**Argon2id**, output 16 bytes, fed as the `secret` input to the
existing HKDF chain. All downstream key derivation
([crypto.ts:101-177](../../web/src/lib/crypto.ts)) is unchanged.

### Parameters

Per-account, stored on `profile.json` next to the salt. Starting values:

```
m = 65536  (KiB → 64 MiB)
t = 3
p = 1
```

These are a starting point, not a contract. Each account carries its
own params, so the security floor can be raised for *new* accounts
without forcing an existing-base rotation. A benchmark on a target
mid-tier device (~Pixel 4a class) is desirable before launch but is
not a launch blocker — params can be tweaked freely for accounts
created after the tweak.

### Salt

16 random bytes, generated client-side at registration, stored on
`profile.json`. Per-user, public (Argon2id is designed for public
salts). Exposed via `GET /v1/resolve/{handle}` alongside
`sharing_public_key` so a returning user's device can fetch it before
running Argon2id.

### Library and execution

Bind the `argon2 = "0.5"` crate inside the existing `web/crypto` Rust
crate via `wasm-bindgen`, alongside the Megolm bindings. Build
infrastructure is already in place; no new JS dependency.

Argon2id runs in a **Web Worker**. A 3–4s synchronous WASM call would
block paint, miss INP budgets, freeze the strength-meter UX during
password confirmation, and prevent any "we're deriving your keys"
animation from rendering.

### New-account UX

Registration shows a standard password + confirm-password pair with a
[zxcvbn-ts](https://github.com/zxcvbn-ts/zxcvbn) strength meter, lazy-loaded
on the registration route only (it does not enter the main bundle, and
login does not need it). The meter **warns** on weak scores but **does
not block** submission. The `@zxcvbn-ts/matcher-pwned` module adds an
opportunistic check against Have I Been Pwned via the k-anonymity API
(SHA-1 prefix, the service never sees the full hash); if offline or HIBP
is unreachable, the meter degrades to local-only scoring and registration
still proceeds. A lockout-acknowledgement checkbox sits next to the
field, same gravity as the existing BIP39 warning: "If you forget this,
your account and history are gone."

No "generate a phrase for me" UI in v2. BIP39 mnemonic generation is
gone from the registration path.

### Login UX

A single password field. The client fetches `salt` + `kdf` from
`resolve`, runs Argon2id (in a worker), then HKDF. There is no fork.

A 12-word BIP39 mnemonic was the original credential and was supported
at login via client-side autodetection for migration-rehearsal
purposes; that path was removed once every account had migrated (see
*Migration* below).

### Wire format

`profile.json` carries two credential fields (always present):

```jsonc
{
  // ...existing...
  "salt": "<base64url, 16 bytes>",
  "kdf": { "type": "argon2id", "m": 65536, "t": 3, "p": 1 }
}
```

`GET /v1/resolve/{handle}` adds `salt` and `kdf` to its response.
Senders ignore both; only the account holder's login flow consumes
them.

The `secret` input to HKDF is `Argon2id(password_utf8, salt, m, t, p,
hash_len=16)`. HKDF parameters are unchanged from ADR-0002.

## Consequences

### Positive

- A user-typed password is no longer a free brute-force target. An
  offline attacker against the published `auth_public_key` pays
  64 MiB × 3 iterations per guess.
- One forward derivation path: every account post-migration runs
  password → Argon2id → HKDF, regardless of whether the user typed a
  generated string or a memorable one.
- Per-account params decouple the security floor from rotations: we
  can bump `m` or `t` for new accounts whenever, without touching
  existing ones.
- Lazy-loading zxcvbn-ts keeps it off the critical bundle. Main
  bundle on routes other than `/register` is unaffected. The library
  is tree-shakeable, so we ship only the matchers and language packs
  we actually use.
- HIBP integration catches the "looks strong but is in every breach
  list" class of password (`P@ssw0rd2024!` scores well locally but
  appears in HIBP). Pure entropy scoring cannot detect this.
- The existing `web/crypto` Rust crate already builds to WASM and
  ships with the SPA. Adding `argon2` is small (~30–50 KiB) and
  composes with the Megolm bindings without restructuring.

### Negative

- **First-device login cost.** ~3–4s per Argon2id run on a Pixel 4a
  budget. Once per device. Animation cover required.
- **Memory ceiling.** 64 MiB per Argon2id call. iOS Safari's WASM
  allocation budget is ~256–384 MB; comfortable now but a future
  bump (e.g. m = 128 MiB) needs to factor this in.
- **Async derivation.** The registration and login hooks become
  worker-mediated. Slightly more complex than the current
  synchronous derivation, and tests need to either spawn a real
  worker or mock the message channel.
- **Single derivation path.** Password → Argon2id → HKDF is the only
  flow; the legacy mnemonic direct-HKDF path and the dual auth-proof
  wire shapes ([adr-0012]) were removed after migration completed.

### Neutral

- The salt is public, on purpose. Argon2id was designed with public
  per-input salts as the standard mode.
- `@scure/bip39` is retained as a runtime dependency for the
  "Surprise me" handle suggester (ADR-0013), not for credentials —
  the legacy mnemonic login decode path that originally needed it is
  gone. Bundle impact is unchanged.
- Strength-meter score is shown but ignored by submit logic. UX
  decision (warn, don't block) — informational, not gated.
- HIBP queries are best-effort. Network failure, ad-blocker
  interference, or an offline registration just means the meter shows
  the local score without the HIBP-match flag. No retry storms, no
  blocking spinner.

## Migration

The original credential was a 12-word BIP39 mnemonic (no `salt`/`kdf`
on `profile.json`). The password flow shipped with a dual-path design
— autodetect login plus v1-and-v2 `profile.json` shapes — kept
deliberately as a rehearsal of the protocol-upgrade mechanism rather
than for any real legacy population. Once every account had migrated
to v2 (rotation, per ADR-0012, populates `salt`/`kdf`/`key_version`),
the legacy paths were removed, leaving a single derivation path. The
rehearsal value of the dual-path pattern is captured; the next
protocol upgrade can follow the same shape.

## Alternatives considered

### scrypt or PBKDF2

Rejected. scrypt is memory-hard but less actively reviewed than
Argon2id in 2026. PBKDF2 is not memory-hard, so an attacker with
GPU/ASIC time crushes it regardless of iteration count. Argon2id is
the OWASP 2024 default for password storage.

### Argon2i or Argon2d (non-hybrid)

Rejected. Argon2i is side-channel resistant but weaker against GPU
attacks. Argon2d is GPU-resistant but data-dependent and thus
vulnerable to side channels. Argon2id is the standard hybrid and the
right call for credential derivation.

### Global Argon2id parameters (not per-account)

Rejected. A global `(m, t, p)` constant would force an entire-base
rotation every time the security floor moves. Per-account params on
`profile.json` make a floor bump trivially incremental.

### Argon2id on the main thread

Rejected. 3–4s of synchronous WASM execution would freeze the UI
during the password-confirm interaction (where the meter must remain
responsive), kill any derivation-time animation, and miss INP
budgets across the board.

### dropbox/zxcvbn (original)

Rejected. The original dropbox implementation has been unmaintained
since 2017 — no dependency updates, no language-pack additions, no
HIBP integration. zxcvbn-ts is the actively maintained TypeScript
rewrite, tree-shakeable, and ships first-party HIBP matching.

### Keep BIP39 generation as an option in v2 registration

Rejected. The product target is end-users. Asking everyone to handle
12-word phrases as their *primary* credential excludes the audience
that lives in a password manager. The system can accept either
format safely (BIP39 round-trips through Argon2id without weakening),
but offering both at registration doubles UX surface for no real
gain. Power users who want generated entropy can paste a strong
random string from their manager.
