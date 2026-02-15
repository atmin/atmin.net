# ADR-0006: Data retention and automated cleanup

Status: Accepted
Date: 2026-02-15

## Context

S3 does not track when an object was last read. `ListObjects` returns only
Key, LastModified (creation/overwrite time), ETag, and Size — no access history.

Without active cleanup, the storage grows unboundedly. Two categories of
data accumulate without providing value:

1. **Abandoned registrations** — users who registered but never sent a message
   or set a display name. These are likely test accounts or abandoned signups.
2. **Inactive users** — users who were once active but stopped using the service.

Both need explicit tracking and a cleanup mechanism, since S3 lifecycle rules
alone cannot express "not accessed in X days" (only "created more than X days ago").

## Decision

### Activity tracking

The server updates a `last_active` timestamp in `users/{uid}/profile.json`
on SSE connect (`GET /v1/events`). This is a natural session-start signal:
it fires once per device per session, not on every request.

The profile write is a read-merge-write: read the existing profile, update
`last_active`, write back. This reuses the same pattern as `PUT /v1/profile`.

```json
{
  "user_id": "01ABC...",
  "invite_handle": "crazy-badger",
  "auth_public_key": "...",
  "sharing_public_key": "...",
  "display_name": "Alice",
  "last_active": "2026-02-15T10:30:00Z",
  "created_at": "2026-02-01T..."
}
```

To avoid redundant writes, the server skips the update if `last_active`
was set within the last hour.

### Retention policies

Two policies, evaluated by a single cleanup routine:

| Policy | Condition | Grace period |
|---|---|---|
| Abandoned registration | No `display_name` and no messages sent | 7 days after `created_at` |
| Inactive user | `last_active` older than threshold | 180 days (configurable) |

"No messages sent" is determined by checking whether `inbox/{uid}/live/`
and `inbox/{uid}/archive/` are both empty (a single `ListObjects` call
with limit 1).

### Cleanup routine

A single function that:

1. Lists all `invites/*.json` files.
2. For each invite, reads the profile by user_id.
3. Evaluates retention policies against `created_at`, `last_active`,
   `display_name`, and inbox emptiness.
4. For users that match a deletion policy, deletes all objects under
   `users/{uid}/`, `inbox/{uid}/`, `backups/{uid}/`, `media/{uid}/`,
   and the `invites/{handle}.json` file.

The routine is idempotent — running it twice has no additional effect.

### Deployment options

The cleanup function can run as:

- **In-process goroutine** on a `time.Ticker` (e.g., daily). Simplest for
  single-instance deployments. Gated by a config flag (`CLEANUP_ENABLED=true`).
- **CLI subcommand** (`server cleanup`) invoked by cron or a scheduled job.
  Better for multi-instance deployments where only one instance should run cleanup.

Both call the same function. No new infrastructure required.

### Safeguards

- **Dry-run mode**: log what would be deleted without deleting. Default for
  first deployment until verified.
- **Batch size limit**: process at most N users per run to bound execution time
  and S3 API costs.
- **Logging**: every deletion is logged with user_id, policy matched, and
  key counts deleted. No PII in logs (user_id is an opaque ULID).

## Consequences

### Requires

- Add `last_active` field to profile.json (ADR-0005).
- Update `handleEvents` (or middleware) to write `last_active` on SSE connect.
- Implement cleanup function with dry-run and batch-limit support.
- Add config: `CLEANUP_ENABLED`, `CLEANUP_INACTIVE_DAYS`, `CLEANUP_BATCH_SIZE`.
- Add CLI subcommand or ticker-based scheduling.

### Positive

- Storage costs stay bounded without manual intervention.
- Abandoned registrations are cleaned up quickly, reducing invite handle pollution.
- No new infrastructure — uses existing S3 operations.
- The cleanup function is testable with MemStore.

### Negative

- The `last_active` write on SSE connect adds one read-merge-write per session.
  Negligible at current scale (one extra S3 round-trip per login).
- Cleanup iterates all invites on each run. At thousands of users this is fine;
  at hundreds of thousands, it would need an index or pagination optimization.
- Users have no warning before deletion. There is no way to reach an
  inactive user — the system has no email, phone, or push channel.

### Deferred

- Pre-deletion warning messages.
- User-initiated account deletion (self-service) — specified in ADR-0005.
- Pre-deletion data export (client-side — server only has encrypted blobs).
- Tiered retention (e.g., keep profile but delete message history after 1 year).

## Alternatives considered

### S3 lifecycle rules only

Rejected. S3 lifecycle rules can delete objects by age (days since creation),
but cannot express "not accessed in X days." They also cannot evaluate
cross-object conditions like "inbox is empty."

### Track access in a separate database

Rejected. Adds an infrastructure dependency (database or Redis) for a
periodic batch job. Writing `last_active` into the existing profile.json
achieves the same result with no new dependencies.

### Never delete, rely on cheap storage

Rejected. Even with cheap S3 storage, unbounded growth of invite handles
pollutes the namespace, and abandoned accounts create a false sense of
user count. Active cleanup is good hygiene.
