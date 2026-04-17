# ADR-0010 — Production logging via Scaleway Cockpit (Loki)

**Date:** 2026-04-17  
**Status:** Accepted

---

## Context

The app runs as a stateless Go container on Scaleway Serverless Containers. Two environments
exist: `app.atmin.net` (prod, always-on) and `staging.atmin.net` (scale-to-zero).

Production visibility was needed: the ability to inspect server logs when something breaks.
The bar is low — occasional manual inspection, not continuous monitoring.

Scaleway Serverless Containers do **not** automatically forward stdout/stderr to Cockpit.

### Options considered

**Scaleway Cockpit (Loki)** — push logs from the app to Cockpit's Loki endpoint using a
Cockpit token. Query via Grafana when needed. Already included in the Scaleway account.

**Third-party log aggregation (Betterstack, Axiom)** — same app-side push, better search UX,
additional dependency and account.

**Periodic pull via GitHub Actions** — query Loki's API on a schedule, hash IPs, write Parquet
to S3 for analytics. Complements the above rather than replacing it.

**Do nothing** — no log visibility beyond local `docker run` output.

## Decision

Push logs to **Scaleway Cockpit** from within the Go server. Stay within the existing
infrastructure ecosystem; no new external accounts.

### Implementation

A `lokiSender` runs a background goroutine that:
- accepts log entries via a non-blocking channel (cap 512 — drops on full, never blocks requests)
- flushes to the Loki push endpoint every 5 seconds, or immediately at 100 buffered entries
- drains and flushes on graceful shutdown (SIGINT/SIGTERM, 5 s timeout)

A `lokiHandler` implements `slog.Handler`. On each record it formats a JSON line (via
`slog.NewJSONHandler` on a `bytes.Buffer`) and sends it to the `lokiSender`, then delegates
to the stderr handler so local/container stdout output is unaffected.

Loki stream labels: `app=atmin`, `env=prod|staging`. Both environments share the same Cockpit
endpoint and are distinguished by the `env` label — separate Grafana queries, no mixed output.

The sender is only activated when `COCKPIT_LOKI_URL` and `COCKPIT_TOKEN` are set. If either
is absent, the server falls back to stderr-only logging with no behaviour change.

### Retention and GDPR

Cockpit default retention is **7 days**. This is intentional: server logs contain IP addresses
(personal data under GDPR). Keeping them for 7 days is sufficient for incident response;
they expire automatically without manual deletion.

### Daily analytics export (future)

A scheduled job (mechanism TBD — see future ADR) will query `{app="atmin", env="prod"}` from
Loki daily, anonymize any PII, and write Parquet files to S3 for long-term analytics. Staging
is excluded by label — no redacted logs are stored for it.

**Anonymization:** IP addresses are the known PII in current logs. Any other PII fields
introduced in future must also be anonymized before the Parquet file is written.

IP addresses are hashed with a random salt generated fresh for each daily export run. A salt
is necessary because the IPv4 space is small enough to enumerate — an unsalted hash of every
possible address can be precomputed in seconds, making reversal trivial. With a per-run random
salt, hashes are irreversible. The salt is discarded after the run, so IPs within a single
day's export can be correlated (same IP → same hash within that file), but the same IP will
produce a different hash in every other day's file, preventing cross-day tracking.

## Consequences

- One new Cockpit token per environment (or shared — they are distinguished by label).
- Two new optional env vars on the production container: `COCKPIT_LOKI_URL`, `COCKPIT_TOKEN`.
  `APP_ENV` must be set on both containers (`prod` / `staging`); omitting it when Loki is
  configured is a fatal startup error.
- No new Go dependencies.
- Logs during a Cockpit ingestion outage (e.g. 2026-04-16 fr-par incident) are lost — Loki
  does not buffer and retry on the platform side.
