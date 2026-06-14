# ADR-0021 — Per-endpoint rate limiting (rocket-governor)

**Date:** 2026-06-14
**Status:** Draft.
**Relates to:** [ADR-0020](./adr-0020-registration-proof-of-work.md) (registration PoW — complementary, not overlapping), [ADR-0007](./adr-0007-registration-abuse-prevention.md) (Superseded — first noted rate limiting as future work), [ADR-0001](./adr-0001-sync-first-s3-mailbox.md) (no PII), [ADR-0004](./adr-0004-sse-realtime-notifications.md) (in-process now, shared later), [ADR-0019](./adr-0019-adopt-rust-backend.md) (single in-process backend), [ADR-0010](./adr-0010-logging.md) (abuse signal in logs), [ops.md](../ops.md) (proxy IP header, env vars).

## Context

Every route is uncapped. [ADR-0020](./adr-0020-registration-proof-of-work.md) taxes
the *cost of a new account*, but it guards one endpoint; nothing bounds request
*rate* anywhere else. The open surfaces:

- **Credential hammering on `POST /v1/devices`** — new-device login verifies an
  Ed25519 auth-proof; unbounded, it invites proof-flooding and stuffing attempts.
- **Enumeration on `GET /v1/resolve/<handle>`** — unauthenticated handle lookup;
  unbounded, it scrapes the handle namespace.
- **Challenge flooding on `GET /v1/register/challenge`** — cheap to mint but each
  call grows the in-process nonce store.
- **Expensive operations** — `POST /v1/rotate-keys` and `POST /v1/store/compact`
  do real S3 work; a tight loop is a cheap amplification lever.
- **General DoS** — any authenticated endpoint hammered from one source.

The backend is a single in-process Rust service ([ADR-0019](./adr-0019-adopt-rust-backend.md)),
so the control must run in-process. This is **defence in depth, not a replacement
for PoW**: PoW handles registration *cost*, this bounds request *rate* across the
whole surface.

## Decision

Adopt **`rocket-governor`** (a GCRA limiter over the `governor` crate) as a
per-endpoint, IP-keyed rate limit, applied as a request guard.

- **Per-endpoint via tiered guard types.** Each tier is its own `RocketGovernable`
  impl with its own quota and its own in-memory bucket; routes attach the guard for
  their tier. `quota()` receives `(method, route_name)`, so a tier may further
  branch by route. Tiers and starting quotas (per IP):

  | Tier | Routes | Quota |
  | --- | --- | --- |
  | **Exempt** | `GET /healthz`, `GET /v1/events` (SSE) | none — uptime probe; SSE is long-lived, per-request limiting is meaningless |
  | **Unauth, tight** | `POST /v1/register` | 10 / hour — PoW already gates it; this caps PoW-farm churn |
  | | `GET /v1/register/challenge` | 30 / min — bounds nonce-store growth, room for prefetch + retry |
  | | `POST /v1/devices` (new-device login) | 10 / min — auth-proof / stuffing surface |
  | | `GET /v1/resolve/<handle>` | 60 / min — handle enumeration |
  | **Auth, generous** | `POST /v1/send` | 60 / min |
  | | presign / object GET / list / usage / object DELETE | 120 / min — clients batch key + media ops |
  | | `PUT /v1/profile`, `devices/revoke`, `DELETE /v1/devices` | 30 / min |
  | **Expensive, tight** | `POST /v1/rotate-keys`, `DELETE /v1/profile` | 5 / hour |
  | | `POST /v1/store/compact` | 12 / hour |

  Numbers are code constants, calibrated like the PoW difficulty — adjustable
  without a protocol change.

- **Keyed by client IP.** `rocket-governor` keys on Rocket's `client_ip()`, which
  honours the configured `ip_header`. **This is only as trustworthy as the edge:**
  the load balancer must *overwrite* that header (not pass a client-supplied one),
  or an attacker rotates the header value and escapes the limit entirely. The header
  name and the LB's overwrite behaviour are pinned in [ops.md](../ops.md). Where no
  header can be trusted the fallback is the peer IP — which is the LB, collapsing all
  clients into one bucket; that is the failure mode the ops config exists to prevent.

- **IP only, never per-user — by design.** `rocket-governor` cannot key on
  `user_id`, so the authenticated tiers are deliberately *generous*: with CGNAT and
  shared egress, a tight per-IP cap would false-positive on real users sharing an
  address. The authenticated tiers are a coarse DoS backstop; per-account fairness
  stays where it already lives — PoW for registration, the media quota for storage.

- **Canonical 429.** The limiter's rejection is mapped to the project's error
  envelope: a `RateLimited` variant on `ApiError` (HTTP 429, code `rate_limited`)
  via a custom catcher, carrying `Retry-After`. One code for all tiers — the
  response is not an oracle for which bucket tripped.

- **Test/e2e enablement — a runtime switch.** `quota()` is a static trait method
  with no access to Rocket state, so the disable is an environment variable
  (`DISABLE_RATE_LIMIT`) read inside `quota()` (queried once per guard type at
  limiter construction); when set, every tier returns an effectively-infinite quota.
  Unlike the PoW switch this needs **no magic-value, fail-closed dance**: disabling
  rate limiting cannot weaken any cryptography or open registration (PoW still
  guards it), so the stakes are low. Default is on. The e2e suite (local *and* the
  CI prod-image run) and the handler-test harness set it — a single localhost IP
  issuing hundreds of fast requests would otherwise trip every tier and make the
  suite flaky. Production does not set it.

## Consequences

- A hammering source is bounded per endpoint; brute-force, scraping, and DoS
  amplification all get a cheap ceiling, in-process and EU-resident.
- **The limit is only as sound as the proxy IP config.** A misconfigured edge
  (passing through a spoofable header) silently defeats it. This is the single
  biggest correctness risk and lives in [ops.md](../ops.md).
- **State is per-instance.** `governor`'s buckets are in-memory, so horizontal
  scaling makes the effective limit ≈ N × quota — the same "in-process now, shared
  (e.g. Redis-backed) later" trade-off as the rest of the server state
  ([ADR-0004](./adr-0004-sse-realtime-notifications.md)). Acceptable at current
  scale; documented, not hidden.
- **Authenticated limits are coarse.** IP-keying means they cannot fairly partition
  abuse between accounts behind one address; they are a DoS backstop only.
- A production-reachable disable switch exists, but disabling rate limiting only
  removes a backstop — it opens no path PoW and per-prefix authorization don't still
  guard.
- 429s are visible in the request log ([ADR-0010](./adr-0010-logging.md)) as an
  abuse signal; a spike is the operational tell.

## Alternatives considered

- **No rate limiting, rely on PoW + per-prefix auth.** Leaves login hammering,
  handle scraping, and expensive-endpoint loops uncapped — PoW guards only
  registration. Rejected; the surfaces are real and the belt is cheap.
- **`tower_governor` / a middleware layer with a `SmartIpKeyExtractor`.** A richer
  IP-extraction story, but it is a `tower` layer — the wrong fit for a Rocket app,
  and the IP-trust question is identical either way (it too believes proxy headers).
  Rejected for the native Rocket guard.
- **Per-user (token-keyed) limits.** The precise control for authenticated abuse,
  but it needs shared per-user state and does nothing for the *unauthenticated*
  surface, which is where the real abuse is. Out of scope; PoW and the media quota
  cover per-account cost today.
- **Edge/LB rate limiting (e.g. at Scaleway).** Plausible later, but provider-coupled
  and outside the single-binary model; keeping the control in-process keeps it
  testable and portable. Revisit if a CDN/edge is introduced.
- **Magic-value fail-closed disable (as ADR-0020's PoW switch uses).** Unnecessary
  here — disabling rate limiting is low-stakes (no crypto, no open registration), so
  a plain boolean env var is the right weight. Rejected as over-engineering for this
  control.
