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

Backup secret rotation (defense-in-depth against compound threats) is deferred.
See [evolution notes](./evolution/device-revocation.md).

This is inherent to any E2E messenger where keys must be available on-device for operation.
OS-level device lock (PIN, biometrics) is the first line of defense — not the application.

## Open questions

- Abuse controls (quotas, rate limiting) without compromising simplicity.

## Milestones (very rough)

- v0.1: invite-only 1:1 messaging, E2E, S3 inbox sync, minimal media.
- v0.2+: opt-in discovery (phone or other), better abuse controls, optional realtime hints.
