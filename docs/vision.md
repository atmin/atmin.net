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

## Open questions

- Abuse controls (quotas, rate limiting) without compromising simplicity.

## Milestones (very rough)

- v0.1: invite-only 1:1 messaging, E2E, S3 inbox sync, minimal media.
- v0.2+: opt-in discovery (phone or other), better abuse controls, optional realtime hints.
