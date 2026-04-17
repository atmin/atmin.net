# ADR-0010 — Production logging via Scaleway Cockpit

**Date:** 2026-04-17  
**Status:** Accepted

---

## Context

The app runs as a stateless Go container on Scaleway Serverless Containers. Production
visibility was needed: the ability to inspect server logs when something breaks.

Initial assumption was that stdout/stderr are not automatically forwarded to Cockpit and
that explicit log pushing from the app would be required. This turned out to be wrong —
**Scaleway forwards container stdout/stderr to Cockpit automatically.** The logs were always
there; Cockpit datasources simply needed a one-time sync to Grafana before they were
queryable (`scw cockpit grafana sync-data-sources`).

## Decision

No application-level changes needed. Write to stderr (existing behaviour) and rely on
Scaleway's automatic log forwarding to Cockpit. Query via Grafana when needed.

## Consequences

- No code changes, no new dependencies, no new env vars.

### Retention and GDPR

Cockpit default retention is **7 days**. This is intentional: server logs contain IP addresses
(personal data under GDPR). Keeping them for 7 days is sufficient for incident response;
they expire automatically without manual deletion.

### Daily analytics export (future)

A scheduled job (mechanism TBD — see future ADR) will query Cockpit's Loki API daily,
anonymize any PII, and write Parquet files to S3 for long-term analytics. Staging is excluded
— no redacted logs are stored for it.

The export job will need a Cockpit token with `read_only_logs` scope — separate from any
container credentials, which don't need Cockpit access at all.

**Anonymization:** IP addresses are the known PII in current logs. Any other PII fields
introduced in future must also be anonymized before the Parquet file is written.

IP addresses are hashed with a random salt generated fresh for each daily export run. A salt
is necessary because the IPv4 space is small enough to enumerate — an unsalted hash can be
reversed trivially. With a per-run random salt, hashes are irreversible. The salt is discarded
after the run, so IPs within a single day's export can be correlated, but the same IP produces
a different hash in every other day's file, preventing cross-day tracking.
