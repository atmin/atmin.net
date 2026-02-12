# ADR-0001: Sync-first S3 mailbox architecture

Status: Accepted
Date: 2026-02-07
Updated: 2026-02-11

## Context

The project aims to build an end-to-end encrypted messenger where:

- the server never sees plaintext,
- clients own their keys and message history,
- the backend remains simple, horizontally scalable, and easy to self-host.

Traditional messaging architectures rely on centralized databases and real-time delivery guarantees.
This increases operational complexity and introduces tight coupling between online presence,
delivery, and storage.

## Decision

We adopt a **sync-first mailbox architecture** backed by **S3-compatible object storage**.

Messages are stored as immutable encrypted envelopes in **per-user** inbox prefixes.
Clients periodically sync their inboxes to retrieve new messages.
Real-time delivery (e.g. WebSocket push) is treated as an optional optimization, not a guarantee.

S3-compatible storage is the primary and authoritative persistence layer.
The server acts as a stateless relay and writer of mailbox objects.

### Per-user, not per-device

Inboxes are addressed to users. All of a user's devices read from the same inbox prefix.
Message encryption (Megolm) allows any device with the session key to decrypt.
Megolm key shares are encrypted with the recipient's public key (derived from
their backup secret) and delivered through the same inbox — no per-device channel needed.

This avoids duplicating envelopes and archives per device, eliminates device enumeration
by other users, and allows new devices to sync existing history without special migration.

### Compaction

All data follows the same lifecycle: write immutable object → compact into archive → delete originals.

Compaction is triggered client-side (on Megolm session rotation) and executed by any stateless
server instance. The operation is idempotent and requires no locking or coordination.

## Consequences

### Positive

- The server remains stateless and easy to scale horizontally.
- Offline delivery is a first-class feature.
- The storage model aligns naturally with end-to-end encryption.
- No central database is required for the MVP.
- The system is resilient to transient server or network failures.
- Self-hosting and minimal deployments are straightforward.
- New devices sync existing history from the same inbox (no migration).
- Compaction keeps blob count manageable without coordination.

### Negative

- Message delivery latency is higher compared to fully realtime systems.
- Inbox listing requires careful key design and client-side pagination.
- Presence and typing indicators are non-trivial and intentionally omitted.
- Abuse prevention and rate limiting are limited without shared state.

### Neutral / Deferred

- Reverse-time indexing or shared caches (e.g. Redis)
  can be introduced later without invalidating this model.
- Phone or contact-based discovery can be layered on top independently.

## Alternatives considered

### Realtime-first messaging with a centralized database

Rejected due to increased operational complexity, stronger coupling to online presence,
and weaker alignment with a privacy-first, client-owned data model.

### Message queues or pub/sub as the primary delivery mechanism

Rejected as unnecessary for an MVP and as an additional infrastructure dependency
without clear benefits over a sync-first design.

### Peer-to-peer delivery

Rejected due to complexity, NAT traversal issues, and poor reliability for offline users.

### Per-device inboxes

Rejected. Duplicates envelopes and archives across devices, complicates new-device sync,
and scales storage linearly with device count. Per-user inboxes with Megolm encryption
provide the same functionality with one copy of each message.

## Notes

This decision intentionally prioritizes simplicity, correctness, and long-term flexibility
over realtime guarantees.
If realtime delivery becomes a critical requirement, it will be added as an optimization layer,
not as a foundational dependency.
