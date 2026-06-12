# Rust server — structured (logfmt) logging per ADR-0010

**Priority: next post-cutover task — the key-backup bugfix has landed (invariant
[I10](../docs/scenarios/invariants/i10-key-backup-object-name-safe.md)). NOT
cutover-gating.** The aggregation *decision* is captured ([ADR-0010](../docs/decisions/adr-0010-logging.md)),
but nothing consumes the logs for field-querying today — no live Cockpit/Grafana
dashboards or alerts. So the Rust server's current logging breaks nothing operational
at cutover; this is conformance-for-when-aggregation-is-turned-on, plus restoring the
request-log signal Go had. Latent, low-urgency.

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

## Decision — the logging stack (settled; this is the boring part)

Read from `rocket-0.5.1/src/log.rs` (`init`, lines 161–177): Rocket installs its own
logger with `log::set_boxed_logger(Box::new(RocketLogger)).is_ok()` and only calls
`log::set_max_level` if that succeeded. **So if we install our own `log` logger before
Rocket builds, Rocket detects one is already set and steps aside** — no panic, no
double-logging, and Rocket's own `log::` output then flows through our logger too.

Therefore: **a small hand-written `impl log::Log` that writes logfmt to stderr.** No
`tracing`, no `tracing-subscriber`, no `log`→`tracing` bridge, no new crate — `log` is
already a dependency; we implement its trait. One global logger captures everything
(Rocket's lines + our `media_quota`/`cleanup` facade lines + the request access line),
all one logfmt shape, and we own the format byte-for-byte for Go field-parity.

Rejected alternatives (and why): `tracing` + `tracing-subscriber` + a logfmt formatter
crate — more dependencies and indirection for output we want exact control over;
overkill for one server with a fixed line shape. A logfmt crate (`femme`, etc.) — a
dependency for ~40 lines of trait impl, and less control over exact field formatting.

## Change

All new code in a new module `server/src/logging.rs`. **No new dependencies.**

1. **`struct LogfmtLogger; impl log::Log for LogfmtLogger`** — one line per record to
   **stderr**, never JSON. Line format: `level=<lowercased level> <message>`. No `time=`
   field — Cockpit stamps each line itself, so our own timestamp is redundant and Go's
   documented shape omits it. `enabled()` respects the max level; `flush()` is a no-op.

2. **`fn logfmt_value(&str) -> Cow<str>`** — the one formatting rule, shared by the
   fairing and the facade lines: a value containing a space, `"`, or `=` is wrapped in
   double quotes with inner `"` escaped; otherwise emitted bare. (This is the
   logfmt/slog quoting rule — matching it is what keeps the output field-queryable.)

3. **`pub fn init()`** — called from `main.rs` **before** Rocket is built/launched:
   - parse the level from `ROCKET_LOG_LEVEL` (`off|critical|normal|debug` →
     `Off|Warn|Info|Trace`), **default `Info`** so requests log;
   - `let _ = log::set_boxed_logger(Box::new(LogfmtLogger));` (ignore an
     already-set logger so it's harmless if ever called twice / from a test);
   - `log::set_max_level(level)`.
   This **replaces the interim `ROCKET_LOG_LEVEL=critical` default** — the env var and
   the knob stay; only the default changes to `Info`. (Because our logger wins, Rocket
   skips its own `set_max_level`, so we set it here ourselves.)

4. **`pub struct RequestLog; impl Fairing for RequestLog`** — the access log, Go's shape:
   - `on_request`: store `std::time::Instant::now()` in the request-local cache under a
     private `struct StartTime(Instant)` type.
   - `on_response`: compute `dur_ms`, read `user_id` from the request-local cache (see
     step 5; empty string when the request didn't authenticate), and emit at INFO:
     `log::info!("msg=request method={method} path={path} status={status} dur_ms={ms} ip={ip} user_id={uid}")`,
     with `path` and `ip` passed through `logfmt_value`.
   - `ip`: first value of `X-Forwarded-For` (Scaleway sets it), else the peer address.
   - Attach with `.attach(logging::RequestLog)` in `routes.rs::build()`.

5. **Stash `user_id` for the fairing** — request-local state is how the guard hands the
   user id to `on_response` (which runs after the handler). Define
   `struct RequestUserId(Option<String>)`; in the `AuthedUser` guard's success path,
   `req.local_cache(|| RequestUserId(Some(user_id)))`; in `on_response`,
   `req.local_cache(|| RequestUserId(None))` reads it (defaulting to `None` for
   unauthenticated routes — `/healthz`, `resolve`, failed auth). One line in `guard.rs`,
   one read in the fairing. (`local_cache` is init-once per type, so `on_request` must
   not touch `RequestUserId` — it only sets `StartTime`.)

6. **Normalize the existing facade lines** (`cleanup`, `media_quota`) to the documented
   field shape — an event token followed by `key=value` fields, quoted via
   `logfmt_value` — so the cleanup line matches Go's `user_id=… handle_key=… policy=…
   dry_run=…`. They already use `log::`, so they flow through the new logger unchanged in
   mechanism; this is only aligning field names and quoting.

Wiring summary: `lib.rs` (`pub mod logging`), `main.rs` (`logging::init()` before launch
+ drop the `critical` default), `routes.rs` (`.attach(logging::RequestLog)`), `guard.rs`
(stash `user_id`), and the field touch-ups in `cleanup.rs` / `media_quota.rs`.

## Verify

- Unit test on `logfmt_value`: a bare token stays bare; a value with a space / `"` / `=`
  is quoted with inner quotes escaped.
- Run the server, hit an endpoint, eyeball stderr: a
  `level=info msg=request method=… path=… status=… dur_ms=… ip=… user_id=…` line, plus
  (e.g.) a cleanup facade line — both `key=value`, not JSON, not double-escaped.
- `ROCKET_LOG_LEVEL=critical ./atmin` silences request logs (Warn+ only); unset logs them
  at Info. The knob still works; only the default changed from `critical` to `Info`.
- Field-query in Grafana (filter by `status`, `user_id`) — verify whenever an aggregator
  is actually stood up; not required to land this task.

## Note

The log line is effectively an observability "wire format" — matching Go's fields keeps
any future Grafana query/dashboard working unchanged, the same field-parity discipline as
the token/JCS/CBOR interop. Just not load-bearing yet, so it waits its turn.
