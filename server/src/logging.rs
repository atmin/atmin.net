//! logfmt (`key=value`) logging per ADR-0010.
//!
//! A hand-written [`log::Log`] writing one line per record to stderr, installed
//! by [`init`] *before* Rocket builds. Rocket 0.5 installs its own logger only
//! when none is set (`log::set_boxed_logger(..).is_ok()` in its `log::init`), so
//! ours wins and Rocket's own `log::` lines flow through it too — one logfmt
//! stream for everything (Rocket's lines, the `cleanup`/`media_quota` facade
//! lines, and the per-request access line).
//!
//! NOT JSON (ADR-0010): Scaleway's collector re-wraps each stderr line in its own
//! JSON envelope, double-escaping a JSON payload into something unreadable and not
//! field-queryable. logfmt text stays readable as-is and queryable in Grafana.
//!
//! Noise control: at the default `normal` level the logger emits only *this
//! crate's* records (target `atmin_server::*` — the request line and the facade
//! lines), so the access log isn't drowned by Rocket's per-request lifecycle
//! chatter (`rocket::*`) or dependency logs. `ROCKET_LOG_LEVEL=debug` lifts the
//! filter and lets everything through for troubleshooting.

use std::borrow::Cow;
use std::io::Write;
use std::time::Instant;

use rocket::fairing::{Fairing, Info, Kind};
use rocket::http::Header;
use rocket::{Data, Request, Response};
use ulid::Ulid;

/// The authenticated user id for the current request, stashed by the `AuthedUser`
/// guard so the request-log fairing can read it in `on_response` (which runs after
/// the handler). `None` for unauthenticated routes or failed auth.
pub struct RequestUserId(pub Option<String>);

/// Per-request start instant, set by the fairing's `on_request`.
struct StartTime(Instant);

/// The correlation id for the current request, set by the fairing's `on_request`
/// and echoed back in the `X-Request-Id` response header.
struct RequestId(String);

/// A request id is safe to interpolate into a log line iff it's a bounded token
/// of `[A-Za-z0-9_-]` — so a client/proxy-supplied `X-Request-Id` can't inject
/// into the logfmt line (via a space, `=`, quote, or newline).
fn is_safe_request_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 64
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The request id: a safe client/proxy-supplied `X-Request-Id` (for cross-tier
/// correlation), else a fresh ULID.
fn request_id_from(req: &Request<'_>) -> String {
    match req.headers().get_one("X-Request-Id") {
        Some(id) if is_safe_request_id(id) => id.to_owned(),
        _ => Ulid::new().to_string(),
    }
}

/// Quote a logfmt value iff it contains a space, `"`, or `=`, escaping inner `"`;
/// otherwise emit it bare. This is the logfmt/slog rule — matching it is what keeps
/// the line field-queryable.
pub fn logfmt_value(s: &str) -> Cow<'_, str> {
    if s.bytes().any(|b| b == b' ' || b == b'"' || b == b'=') {
        Cow::Owned(format!("\"{}\"", s.replace('"', "\\\"")))
    } else {
        Cow::Borrowed(s)
    }
}

struct LogfmtLogger;

impl log::Log for LogfmtLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        // Default (normal/Info): a clean access log — emit only this crate's own
        // structured lines (the request fairing + the `cleanup`/`media_quota`
        // facade), dropping Rocket's per-request lifecycle chatter (`Matched:`,
        // `Outcome:`, `Response succeeded.`, 404/SSE warnings — all `rocket::*`
        // targets) and dependency noise. At debug level, let everything through
        // for troubleshooting.
        let verbose = log::max_level() >= log::LevelFilter::Debug;
        if !verbose && !record.target().starts_with("atmin_server") {
            return;
        }
        // `level=<lvl> <message>`. Our own lines put logfmt fields in the message;
        // pass-through lines (only at debug) are free text but still readable. No
        // `time=` — Cockpit stamps each line.
        let level = record.level().as_str().to_ascii_lowercase();
        let line = format!("level={level} {}\n", record.args());
        let _ = std::io::stderr().write_all(line.as_bytes());
    }

    fn flush(&self) {}
}

/// Install the logfmt logger and set the max level from `ROCKET_LOG_LEVEL`
/// (`off|critical|normal|debug`, default `Info` so requests log). Call once,
/// before Rocket builds. Idempotent: an already-set logger (a second call, or a
/// test harness) is left in place.
pub fn init() {
    let level = match std::env::var("ROCKET_LOG_LEVEL").as_deref() {
        Ok("off") => log::LevelFilter::Off,
        Ok("critical") => log::LevelFilter::Warn,
        Ok("debug") => log::LevelFilter::Trace,
        _ => log::LevelFilter::Info, // "normal", unset, or anything else
    };
    let _ = log::set_boxed_logger(Box::new(LogfmtLogger));
    log::set_max_level(level);
}

/// Per-request access log emitting Go's field shape, plus a correlation id:
/// `msg=request request_id=… method=… path=… status=… dur_ms=… ip=… user_id=…`.
/// The same id is echoed in the `X-Request-Id` response header so a client can
/// quote it when reporting an error — the handle into these logs.
pub struct RequestLog;

#[rocket::async_trait]
impl Fairing for RequestLog {
    fn info(&self) -> Info {
        Info {
            name: "request log (logfmt)",
            kind: Kind::Request | Kind::Response,
        }
    }

    async fn on_request(&self, req: &mut Request<'_>, _data: &mut Data<'_>) {
        // Init-once per type. Set the timer and the request id here; never
        // RequestUserId (the guard owns that — pre-empting it with None loses it).
        let id = request_id_from(req);
        req.local_cache(|| StartTime(Instant::now()));
        req.local_cache(|| RequestId(id));
    }

    async fn on_response<'r>(&self, req: &'r Request<'_>, res: &mut Response<'r>) {
        let request_id = req.local_cache(|| RequestId(String::new())).0.as_str();
        let dur_ms = req
            .local_cache(|| StartTime(Instant::now()))
            .0
            .elapsed()
            .as_millis();
        let method = req.method().as_str();
        let status = res.status().code;
        let path = logfmt_value(req.uri().path().as_str());
        let ip_str = client_ip(req);
        let ip = logfmt_value(&ip_str);
        let uid_str = req
            .local_cache(|| RequestUserId(None))
            .0
            .clone()
            .unwrap_or_default();
        let uid = logfmt_value(&uid_str);

        // request_id is a validated safe token (ULID or vetted X-Request-Id), so
        // it needs no logfmt quoting.
        log::info!(
            "msg=request request_id={request_id} method={method} path={path} status={status} dur_ms={dur_ms} ip={ip} user_id={uid}"
        );

        // Echo the id so the client can quote it when reporting an error.
        res.set_header(Header::new("X-Request-Id", request_id.to_owned()));
    }
}

/// The client IP: first `X-Forwarded-For` value (Scaleway sets it), else the
/// remote peer address, else empty.
fn client_ip(req: &Request<'_>) -> String {
    req.headers()
        .get_one("X-Forwarded-For")
        .and_then(|xff| xff.split(',').next())
        .map(|s| s.trim().to_owned())
        .or_else(|| req.remote().map(|addr| addr.ip().to_string()))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{is_safe_request_id, logfmt_value};

    #[test]
    fn request_id_safety_rejects_injection() {
        assert!(is_safe_request_id("01HWQA8Z6NXY")); // ULID
        assert!(is_safe_request_id("trace-abc_123")); // vetted client id
        assert!(!is_safe_request_id("")); // empty
        assert!(!is_safe_request_id("has space")); // would split fields
        assert!(!is_safe_request_id("inject\nline")); // would break the line
        assert!(!is_safe_request_id("a=b")); // would forge a field
        assert!(!is_safe_request_id(&"x".repeat(65))); // unbounded
    }

    #[test]
    fn logfmt_value_quotes_only_when_needed() {
        // Bare: no space, quote, or equals.
        assert_eq!(logfmt_value("01HWQA"), "01HWQA");
        assert_eq!(logfmt_value("keys/u1/live/a-b_c"), "keys/u1/live/a-b_c");
        assert_eq!(logfmt_value(""), "");
        // Quoted: space / equals / quote present, inner quotes escaped.
        assert_eq!(logfmt_value("two words"), "\"two words\"");
        assert_eq!(logfmt_value("a=b"), "\"a=b\"");
        assert_eq!(logfmt_value("say \"hi\""), "\"say \\\"hi\\\"\"");
    }
}
