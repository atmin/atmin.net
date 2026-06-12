# Service telemetry and privacy-preserving analytics

How telemetry might grow beyond the per-request access log, and the privacy
architecture that lets analytics happen without compromising the system's
no-plaintext-on-the-server promise. Speculative — **not a roadmap or a commitment.**

## What exists today

The server emits one logfmt access line per request
([ADR-0010](../decisions/adr-0010-logging.md), `server/src/logging.rs`):

```
msg=request request_id=… method=… path=… status=… dur_ms=… ip=… user_id=…
```

`request_id` is a ULID (or a vetted inbound `X-Request-Id`), echoed back in the
`X-Request-Id` response header. Lines flow to Scaleway Cockpit (stderr → Loki,
7-day retention). At the default level only the app's own lines are emitted;
`ROCKET_LOG_LEVEL=debug` lifts the filter for tracing a request.

## Two tiers: ephemeral PII, durable anonymous

The privacy bar is **no PII in *durable* storage** — where "durable" means the
analytics tier, **not** the operational logs. The two tiers have different legal
characters:

- **Cockpit (operational) — PII permitted, 7-day retention.** Raw `ip` / `user_id`
  / `request_id` are intentional here, for incident response. A short, fixed
  retention under a clear policy is GDPR-defensible (legitimate interest, bounded
  window). This is the tier the access line feeds today.
- **Parquet on S3 (analytics) — no PII, durable.** A periodic job aggregates the
  operational logs into columnar Parquet, anonymizing *at write time*, so the
  durable artifact is queryable for traffic patterns without holding personal data.

## The aggregation job (sketch)

A scheduled one-shot, in the mould of the cleanup job (a Scaleway Serverless Job —
[ADR-0006](../decisions/adr-0006-data-retention.md)), running ~daily, reading the
prior day's logs (a Loki query, well within the 7-day window) and writing Parquet to
S3. At write time:

- generate a **random daily salt**, held in memory for the run only and **never
  persisted**;
- **hash IPs** with that salt;
- **MaxMind GeoLite2 as a local database** — looked up in-process, *no per-request
  third-party API call*, so IPs never leave the box — derive and store **country**
  in place of the IP;
- use the salt to **sanitize user-identifying parts of URLs** (handles / user_ids in
  paths). Prefer the **route template** (`/v1/resolve/:handle`) where per-value
  counts aren't needed (zero value retained); hash the segment only where per-value
  granularity is genuinely wanted;
- **drop `user_id`.**

## Why this works: anonymous, not pseudonymous

Because the salt is destroyed after the run, the hashes are **non-reversible** — which
makes the Parquet tier **anonymous data, not merely pseudonymous**. Truly anonymous
data is *outside* GDPR scope: no retention clock, no erasure obligation, indefinitely
queryable. That is the load-bearing property; it's what lets analytics be permanent
while the only reversible PII (Cockpit) self-expires in 7 days.

**Trade-off, accepted by design:** correlation by hashed-IP works *within* a day; a
fresh salt each day makes *cross-day* linkage impossible, so multi-day analysis lives
at country / aggregate granularity. Utility where it's needed, unlinkability
everywhere else. (Handles are low-entropy and enumerable, so a hashed URL segment is
safe *only* because the salt dies — same property as the IP, and the reason a
persisted salt would be a mistake.)

## Client-side error reporting ("poor man's Sentry")

The client holds `request_id` (from the `X-Request-Id` response header), so a
client-side error handler can `POST` an error report carrying it and correlate to the
server access line. Self-hosting the ingest endpoint is **better than hosted Sentry
for the EU-residency stance** (`docs/ops.md`) — no third-party egress, same reason a
GeoIP *database* is preferred over a GeoIP *API*.

Three things shape the design:

- **`request_id` is a partial handle, not a universal key.** Most of this app's
  errors are client-side (E2E decryption, IndexedDB, rendering) with no server
  request, and network failures have no response header at all. Make `request_id`
  optional; group client-only errors by error code + app version.
- **The endpoint is unauthenticated — an abuse / log-flood vector.** Bounded payload
  size + rate limiting are mandatory (ties to the abuse-resistance plan,
  [ADR-0007](../decisions/adr-0007-registration-abuse-prevention.md)). Treat reports
  as spoofable, low-trust telemetry.
- **Content PII is the dominant E2E risk.** Stack traces and error messages can
  smuggle decrypted bodies / keys / handles / contacts back to the server, defeating
  the whole no-plaintext premise. Scrub at the client with an **allowlist**
  (`request_id`, app version, error code, route name, a redacted stack — file:line,
  never variable values or the raw message); treat the payload as hostile.

## Status / next step

Speculative; not built. The access-line foundation (`request_id` + `X-Request-Id`)
exists. When this is committed to, the aggregation job's trust boundary and the
anonymization guarantee warrant their **own ADR**; [ADR-0010](../decisions/adr-0010-logging.md)
stays the narrow logging-*format* decision and is not expanded.
