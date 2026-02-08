# ADR-0001: Sync-first S3 mailbox architecture

Status: Accepted  
Date: 2026-02-07

## Context

The project aims to build an end-to-end encrypted messenger where:

- the server never sees plaintext,
- clients own their keys and message history,
- the backend remains simple, horizontally scalable, and easy to self-host.

Traditional messaging architectures rely on centralized databases and real-time delivery guarantees.
This increases operational complexity and introduces tight coupling between online presence,
delivery, and storage.

For an early-stage system, this complexity is unnecessary and works against the project's
privacy and simplicity goals.

## Decision

We adopt a **sync-first mailbox architecture** backed by **S3-compatible object storage**.

Messages are stored as immutable encrypted data in per-device inbox prefixes (either as individual envelopes or as append-only segment logs).
Clients periodically sync their inboxes to retrieve new messages.
Real-time delivery (e.g. WebSocket push) is treated as an optional optimization, not a guarantee.

S3-compatible storage is the primary and authoritative persistence layer.
The server acts as a stateless relay and writer of mailbox objects.

## Consequences

### Positive

- The server remains stateless and easy to scale horizontally.
- Offline delivery is a first-class feature.
- The storage model aligns naturally with end-to-end encryption.
- No central database is required for the MVP.
- The system is resilient to transient server or network failures.
- Self-hosting and minimal deployments are straightforward.

### Negative

- Message delivery latency is higher compared to fully realtime systems.
- Inbox listing requires careful key design and client-side pagination.
- Presence and typing indicators are non-trivial and intentionally omitted.
- Abuse prevention and rate limiting are limited without shared state.

### Neutral / Deferred

- Implementation may use segment logs to reduce object counts and sync overhead.
- Reverse-time indexing, segment-based logs, or shared caches (e.g. Redis)
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

## Notes

This decision intentionally prioritizes simplicity, correctness, and long-term flexibility
over realtime guarantees.
If realtime delivery becomes a critical requirement, it will be added as an optimization layer,
not as a foundational dependency.
