# Vision

## Summary

atmin.net is an experimental, privacy-first messenger built around a simple boundary:
the server is a dumb relay + mailbox, while clients own keys, history, and trust.

## Goals

- End-to-end encryption by default (no plaintext on the server).
- Sync-first delivery model (offline-friendly by design).
- Browser-first client (PWA) with minimal friction.
- Simple, horizontally scalable server (stateless where possible).
- S3-compatible storage for messages and media.

## Non-goals

**Deferred** (likely future, not v0.1):

- Phone number or address book based discovery.
- Groups, presence (typing/online), read receipts.

**Out of scope** (no plans):

- Server-side search, moderation, or content analysis (server can't read E2E content).
- Compatibility with Signal/Matrix networks.

## Principles

- **Client-owned data**: history and keys live on the client; backup is optional and encrypted.
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
- If all devices are lost and no backup key exists, history is unrecoverable by design.

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
  storage-usage visibility. Detailed in
  [specs/mvp-v0.1.md](specs/mvp-v0.1.md). Nearly complete — remaining
  work tracked in [tasks/](../tasks/README.md).
- **v0.2** — group chats, background delivery, reach, and a UX refresh.
  Group conversations (the headline, sketched), Web Push notifications,
  iOS "add to home screen" install hint, message-list virtualization, a
  UX pass (polish, simplification, a time-aware timeline, broader
  theming), history export, and (still firming up) opt-in discovery,
  better abuse controls, and optional realtime hints. Drafted in
  [specs/v0.2.md](specs/v0.2.md); scope iterates.
