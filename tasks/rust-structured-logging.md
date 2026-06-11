# Rust server — structured (logfmt) logging per ADR-0010

**Priority: after the [key-backup bugfix](key-backup-unsafe-session-id-key.md). NOT
cutover-gating.** The aggregation *decision* is captured ([ADR-0010](../docs/decisions/adr-0010-logging.md)),
but nothing consumes the logs for field-querying today — no live Cockpit/Grafana
dashboards or alerts. So the Rust server's current logging breaks nothing operational
at cutover; this is conformance-for-when-aggregation-is-turned-on, plus restoring the
request-log signal Go had. Latent, low-urgency, do it after the nasty bug.

## Spec (ADR-0010)

`slog.NewTextHandler` — **logfmt `key=value` text** to stderr → Scaleway forwards
container stderr to Cockpit → queryable in Grafana. **Explicitly NOT JSON**: JSON was
tried and reverted because Scaleway's collector wraps every stderr line in its own JSON
envelope, double-escaping the payload into something unreadable and not field-queryable
(`| json | line_format … | json` is the fragile workaround). Text logfmt is readable
as-is and field-queryable once aggregation is on.

Go's fields (the shape to match so future queries/dashboards are drop-in):
- request line: `msg=request method=… path=… status=… dur_ms=… ip=… user_id=…`
- cleanup job: `user_id=… handle_key=… policy=… dry_run=…`

## Current (Rust)

- Rocket's built-in logger — not logfmt, different shape.
- `main.rs` defaults `ROCKET_LOG_LEVEL=critical` (an interim quieting from the e2e
  hunt) → near-silent, **no per-request logging** at all.
- The `log::` facade lines already in the code (`media_quota` `list_truncated`,
  `cleanup` match/summary) have **no subscriber** → they vanish.

So the Rust server neither emits Go's request-log shape nor surfaces the facade lines,
and what it does emit isn't logfmt.

## Change

1. **A logfmt (`key=value`, NOT JSON) sink to stderr** that captures *both* Rocket's own
   logs and the `log::` facade lines. Design at implementation time — `tracing` +
   a logfmt formatter, or a custom `log::Log`; Rocket 0.5 installs its own `log` logger,
   so reconcile (likely: a global logfmt logger for the facade + a request fairing for
   the access log, with Rocket's own chatter dialed down).
2. **Request-logging fairing** emitting Go's fields: `msg=request method path status
   dur_ms ip user_id` (`ip` from `X-Forwarded-For` / remote; `user_id` from the authed
   context when present), at INFO — drop-in with the captured format.
3. **Route the `log::` facade lines** (`media_quota`, `cleanup`) through the same sink,
   same logfmt shape.
4. **Reconcile the interim `ROCKET_LOG_LEVEL=critical` default** — restore useful
   request logging (Go logged every request at INFO); this task supersedes that quieting.

## Verify

- Sample stderr matches Go's logfmt shape: a `msg=request …` line + a facade line, both
  `key=value`, not JSON, not double-escaped.
- The fields parse in Grafana once `scw cockpit grafana sync-data-sources` is run
  (filter by `status`, `user_id`, etc.) — verify whenever an aggregator is actually
  stood up; not required to land this task.
- Default run logs requests at a useful level, still overridable via `ROCKET_LOG_LEVEL`.

## Note

The log line is effectively an observability "wire format" — matching Go's fields keeps
any future Grafana query/dashboard working unchanged, the same field-parity discipline as
the token/JCS/CBOR interop. Just not load-bearing yet, so it waits its turn.
