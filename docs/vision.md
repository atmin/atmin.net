# Vision

## Summary

atmin.net is an experimental, privacy-first messenger built around a simple boundary:
the server is a dumb relay + mailbox, while clients own keys, history, and trust.

## Goals

- End-to-end encryption by default (no plaintext on the server).
- Sync-first delivery model (offline-friendly by design).
- Browser-first client (PWA) with minimal friction.
- Frictionless, privacy-preserving discovery — no real-world identifier required to join; opt-in contact matching never uploads your address book.
- Simple, horizontally scalable server (stateless where possible).
- S3-compatible storage for messages and media.

## Non-goals

**Deferred** (likely future, not v0.1):

- Phone or address-book discovery — opt-in and privacy-preserving, on the native-apps track.
- Groups, presence (typing/online), read receipts.

**Out of scope** (no plans):

- Server-side search, moderation, or content analysis (server can't read E2E content).
- Compatibility with Signal/Matrix networks.

## Principles

- **Client-owned data**: history and keys live on the client and are backed up to the server encrypted, openable only with your password.
- **Minimal metadata**: store only what is needed for routing and abuse prevention.
- **Incremental complexity**: add shared state (Redis/DB) only when justified by concrete needs.

## Threat model (v0.1)

- Server is honest-but-curious: it may observe metadata and traffic patterns.
- E2E provides confidentiality and integrity of message content.
- No attempt to hide who talks to whom (traffic analysis resistance is out of scope).
- Handles are public identifiers, not secrets. `GET /v1/resolve/{handle}`
  is unauthenticated, so handle/account existence — and, via the `410`
  cooldown response, that an account was deleted and roughly when — is
  intentionally observable. Bulk enumeration of the namespace is therefore
  possible and **accepted for v0.1** (see
  [ADR-0013](./decisions/adr-0013-user-chosen-handles.md)); resolve is
  unthrottled and rate-limiting is a deferred abuse control (see
  [Open questions](#open-questions)). What stays secret is everything
  behind the handle — messages, contacts, devices, keys.
  - _Known, deferrable lever:_ bare **existence** can't be hidden (resolve
    must be open on the pre-login path so a returning device can fetch
    `salt`/`kdf` before it can authenticate), but the **deletion-timing**
    leak is a design choice, not an inherent property. The `410` cooldown
    response exists only to let the registration UI distinguish "deleted,
    coming back" from "never used"; collapsing `410`→`404` would hide that
    an account ever existed at the cost of that UX nicety. Revisit if
    deletion-privacy ever becomes a goal.
- Lose every device and forget your password, and the encrypted backup can never be opened — account and history are unrecoverable by design. There is no recovery mechanism.

### Device compromise

A compromised device (lost phone, unlocked browser) gives the attacker:

- All locally stored chat history (IndexedDB plaintext).
- Sharing private key → can decrypt all key shares (past and in-flight).
- Backup encryption key → can decrypt all key backups on S3.
- Device token → can sync inbox, read new messages, send as the user.

The attacker **cannot** add new devices (requires the backup secret, which is not on-device).

**v0.1 mitigation**: token revocation. Revoking a device deletes its device file;
the server rejects all subsequent API calls. Without API access, the attacker's
cryptographic keys are useless — they cannot obtain new ciphertexts to decrypt.
Damage is limited to whatever was already downloaded before revocation.

Backup-secret rotation (defense-in-depth against compound threats, and a
user-facing "change password") shipped in v0.1 — see
[ADR-0012](./decisions/adr-0012-backup-secret-rotation.md). Rotating
re-keys the account and cuts off every other device immediately.

This is inherent to any E2E messenger where keys must be available on-device for operation.
OS-level device lock (PIN, biometrics) is the first line of defense — not the application.

## Open questions

- Abuse controls (quotas, rate limiting) without compromising simplicity.

## Milestones (very rough)

- **v0.1** — the baseline messenger. Invite-only 1:1 messaging, E2E
  (Megolm + ECIES), S3 inbox sync, media, password credentials
  (Argon2id) with change-password rotation, user-chosen handles,
  message edit/delete, account deletion, server-side cleanup, and
  storage-usage visibility. Complete and frozen — detailed in
  [specs/mvp-v0.1.md](specs/mvp-v0.1.md).
- **v0.2 — the UI revamp.** Every screen rebuilt on a native-feel
  component system (Konsta UI, motion via View Transitions), the
  single-image media quality suite (optimized send, EXIF strip,
  previews, offline cache), a memory-hard registration proof-of-work,
  and a time-aware timeline. A meaningful, non-big-bang release.
  Shipped as `v0.2.0` (2026-06) — surface in
  [specs/v0.2.md](specs/v0.2.md), what shipped in
  [releases/v0.2.md](releases/v0.2.md).
- **v0.3 — group chats & data portability.** Group conversations (the
  headline; Megolm already a group ratchet, the hard parts are
  membership + rekey) with fragment-addressed rooms, multipart-media
  albums, history export/import, broader theming, and (still firming
  up) opt-in discovery, rate-limiting, and realtime hints. Drafted in
  [specs/v0.3.md](specs/v0.3.md); scope iterates. Background delivery
  and iOS reach remain on the native-apps track.
