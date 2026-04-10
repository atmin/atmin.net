# Real-time delivery

- Realtime delivery is best-effort; sync from storage is authoritative.
- v0.1 uses SSE for instant "new message" hints (see [ADR-0004](../decisions/adr-0004-sse-realtime-notifications.md)).
- Multi-instance scaling requires a pub/sub layer (Redis, NATS) for
  cross-instance fanout. The EventHub API stays unchanged.

Realtime must not become a correctness dependency.
