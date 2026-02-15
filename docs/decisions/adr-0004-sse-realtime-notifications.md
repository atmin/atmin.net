# ADR-0004: Server-Sent Events for realtime notifications

Status: Accepted
Date: 2026-02-15

## Context

ADR-0001 established a sync-first architecture where clients poll S3 for new messages.
This works correctly but introduces noticeable latency — messages appear only after
the next sync cycle or manual refresh.

SSE was identified as the simplest way to eliminate this latency while preserving
the sync-first design: the server notifies clients to sync, rather than delivering
message content directly.

## Decision

We add an in-memory **EventHub** that tracks active SSE connections per user.
When `/v1/send` writes envelopes to S3, it also notifies all connected clients
of the recipient via SSE. Clients respond by calling the existing `fetchMessages()`
sync path.

The EventHub is **in-process only**. It holds no durable state and loses all
connections on restart. This is acceptable because:

- SSE clients auto-reconnect (built into the EventSource API).
- The sync-first model remains the source of truth — SSE is purely advisory.
- A single Go process handles tens of thousands of concurrent SSE connections.

### Auth for EventSource

EventSource does not support custom headers. The auth token is passed as a query
parameter (`/v1/events?token=...`). The existing `requireAuth` middleware accepts
tokens from either the `Authorization` header or the `token` query parameter.

## Consequences

### Positive

- Messages appear instantly without polling.
- Zero new infrastructure — no Redis, no message broker.
- Client code is minimal: one `EventSource` + existing sync logic.
- Graceful degradation: if SSE disconnects, the app still works via sync-on-load.

### Negative

- **The server is no longer fully stateless.** The EventHub holds ephemeral
  connection state in memory. This does not affect correctness (sync-first
  remains authoritative) but prevents naive horizontal scaling.

### Scaling strategy

When multiple server instances are needed:

1. Add a pub/sub backend (Redis, NATS, or Valkey).
2. `handleSend` publishes a `new_message` event to the pub/sub channel
   instead of calling `hub.Notify()` directly.
3. Each server instance subscribes to the channel and fans out to its
   local EventHub connections.

The EventHub API stays unchanged. The change is ~30 lines of glue code
in `main.go` and `handlers.go`.

## Alternatives considered

### WebSockets

Rejected. Bidirectional communication is unnecessary — the server only needs
to push notifications. SSE is simpler, uses standard HTTP, auto-reconnects,
and works through most proxies without configuration.

### Polling with short interval

Rejected. Even a 5-second poll interval wastes bandwidth and feels sluggish
compared to instant delivery.

### Redis pub/sub from day one

Rejected. Adds an infrastructure dependency for a single-instance deployment.
The in-memory EventHub is correct for the current scale and can be swapped
for Redis later without changing the client or the EventHub interface.
