//! Canonical API errors → Rocket responses.
//!
//! Every variant maps to a `{ "error": <code>, "message": <msg> }` body and a
//! fixed HTTP status. Modeling these as an enum means a handler returning
//! `Result<T, ApiError>` enumerates exactly its failure modes and the compiler
//! checks the match.

use crate::model::KeyVersion;
use crate::store::StoreError;
use rocket::http::{ContentType, Status};
use rocket::response::{self, Responder, Response};
use rocket::Request;
use std::io::Cursor;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ApiError {
    BadRequest,
    Unauthorized,
    /// 401 from the auth guard; carries the account's current `key_version`
    /// so the client knows what to re-login at. (Rotate-keys also raises this as a
    /// 409 precondition failure, overriding the status at the handler.)
    KeyVersionStale {
        current: KeyVersion,
    },
    DeviceRevoked,
    BadContinuity,
    Forbidden,
    NotFound,
    HandleInvalid,
    HandleReserved,
    HandleTaken,
    /// 409 when *registering* a handle still in its 30-day cooldown (ADR-0013);
    /// carries the timestamps the client renders.
    HandleInCooldown {
        released_at: String,
        available_at: String,
    },
    /// 410 when *resolving* a deleted handle in cooldown (ADR-0013); same timestamps.
    HandleReleased {
        released_at: String,
        available_at: String,
    },
    RegistrationUnavailable,
    /// 403 when registration's proof-of-work is missing, malformed, expired,
    /// replayed, or wrong (ADR-0020). One code for every failure mode — never an
    /// oracle for nonce state.
    PowInvalid,
    QuotaExceeded,
    TooLarge,
    /// 500 with an ad-hoc context message for one-off internal failures.
    Internal(String),
}

impl ApiError {
    pub fn status(&self) -> Status {
        use ApiError::*;
        match self {
            BadRequest | HandleInvalid | HandleReserved => Status::BadRequest,
            Unauthorized | KeyVersionStale { .. } => Status::Unauthorized,
            DeviceRevoked | BadContinuity | Forbidden | PowInvalid => Status::Forbidden,
            NotFound => Status::NotFound,
            HandleTaken | HandleInCooldown { .. } => Status::Conflict,
            HandleReleased { .. } => Status::Gone,
            RegistrationUnavailable => Status::ServiceUnavailable,
            QuotaExceeded | TooLarge => Status::PayloadTooLarge,
            Internal(_) => Status::InternalServerError,
        }
    }

    pub fn code(&self) -> &'static str {
        use ApiError::*;
        match self {
            BadRequest => "bad_request",
            Unauthorized => "unauthorized",
            KeyVersionStale { .. } => "key_version_stale",
            DeviceRevoked => "device_revoked",
            BadContinuity => "bad_continuity",
            Forbidden => "forbidden",
            NotFound => "not_found",
            HandleInvalid => "handle_invalid",
            HandleReserved => "handle_reserved",
            HandleTaken => "handle_taken",
            HandleInCooldown { .. } => "handle_in_cooldown",
            HandleReleased { .. } => "released",
            RegistrationUnavailable => "registration_unavailable",
            PowInvalid => "pow_invalid",
            QuotaExceeded => "quota_exceeded",
            TooLarge => "too_large",
            Internal(_) => "internal",
        }
    }

    pub fn message(&self) -> &str {
        use ApiError::*;
        match self {
            BadRequest => "Malformed input",
            Unauthorized => "Missing or invalid token",
            KeyVersionStale { .. } => "Token or auth proof bound to a superseded key_version",
            DeviceRevoked => "Device has been revoked",
            BadContinuity => "Continuity signature did not verify",
            Forbidden => "Access denied",
            NotFound => "Not found",
            HandleInvalid => "Handle does not match the required format",
            HandleReserved => "Handle is reserved",
            HandleTaken => "Handle is already registered",
            HandleInCooldown { .. } => "Handle is in 30-day cooldown after deletion",
            HandleReleased { .. } => "Handle was deleted; in cooldown",
            RegistrationUnavailable => "Registration is temporarily unavailable for this handle",
            PowInvalid => "Registration proof-of-work missing or invalid",
            QuotaExceeded => "Storage quota exceeded",
            TooLarge => "Payload exceeds size limit",
            Internal(msg) => msg,
        }
    }

    /// The JSON body: `{ "error", "message" }` plus any per-variant extras.
    fn body(&self) -> serde_json::Value {
        let mut body = serde_json::json!({ "error": self.code(), "message": self.message() });
        match self {
            ApiError::KeyVersionStale { current } => {
                body["current"] = serde_json::json!(current.get());
            }
            ApiError::HandleReleased {
                released_at,
                available_at,
            }
            | ApiError::HandleInCooldown {
                released_at,
                available_at,
            } => {
                body["released_at"] = serde_json::json!(released_at);
                body["available_at"] = serde_json::json!(available_at);
            }
            _ => {}
        }
        body
    }
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for ApiError {}

/// Lets handlers use `?` on store calls: a missing object becomes a 404, any
/// other backend failure a 500.
impl From<StoreError> for ApiError {
    fn from(e: StoreError) -> Self {
        match e {
            StoreError::NotFound => ApiError::NotFound,
            StoreError::Backend(err) => ApiError::Internal(err.to_string()),
        }
    }
}

impl<'r> Responder<'r, 'static> for ApiError {
    fn respond_to(self, _: &'r Request<'_>) -> response::Result<'static> {
        let body = self.body().to_string();
        Response::build()
            .status(self.status())
            .header(ContentType::JSON)
            .sized_body(body.len(), Cursor::new(body))
            .ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocket::local::blocking::Client;
    use rocket::{get, routes};

    // Defined at module level, not inside the test fn: a route macro nested in a
    // function trips the `non_local_definitions` lint (which -D warnings rejects).
    #[get("/boom")]
    fn boom() -> ApiError {
        ApiError::HandleTaken
    }

    #[test]
    fn status_and_code_match_go() {
        let cases: &[(ApiError, u16, &str)] = &[
            (ApiError::BadRequest, 400, "bad_request"),
            (ApiError::Unauthorized, 401, "unauthorized"),
            (ApiError::DeviceRevoked, 403, "device_revoked"),
            (ApiError::BadContinuity, 403, "bad_continuity"),
            (ApiError::Forbidden, 403, "forbidden"),
            (ApiError::NotFound, 404, "not_found"),
            (ApiError::HandleInvalid, 400, "handle_invalid"),
            (ApiError::HandleReserved, 400, "handle_reserved"),
            (ApiError::HandleTaken, 409, "handle_taken"),
            (
                ApiError::HandleInCooldown {
                    released_at: "2099-01-01T00:00:00Z".into(),
                    available_at: "2099-01-31T00:00:00Z".into(),
                },
                409,
                "handle_in_cooldown",
            ),
            (
                ApiError::HandleReleased {
                    released_at: "2099-01-01T00:00:00Z".into(),
                    available_at: "2099-01-31T00:00:00Z".into(),
                },
                410,
                "released",
            ),
            (
                ApiError::RegistrationUnavailable,
                503,
                "registration_unavailable",
            ),
            (ApiError::PowInvalid, 403, "pow_invalid"),
            (ApiError::QuotaExceeded, 413, "quota_exceeded"),
            (ApiError::TooLarge, 413, "too_large"),
            (ApiError::Internal("boom".into()), 500, "internal"),
        ];
        for (err, status, code) in cases {
            assert_eq!(err.status().code, *status, "status for {code}");
            assert_eq!(err.code(), *code);
            assert!(!err.message().is_empty());
        }
    }

    #[test]
    fn key_version_stale_carries_current() {
        let err = ApiError::KeyVersionStale {
            current: KeyVersion::new(4).unwrap(),
        };
        assert_eq!(err.status().code, 401);
        assert_eq!(err.code(), "key_version_stale");
        let body = err.body();
        assert_eq!(body["error"], "key_version_stale");
        assert_eq!(body["current"], 4);
    }

    #[test]
    fn handle_released_carries_timestamps() {
        let err = ApiError::HandleReleased {
            released_at: "2026-01-01T00:00:00Z".into(),
            available_at: "2026-01-31T00:00:00Z".into(),
        };
        assert_eq!(err.status().code, 410);
        let body = err.body();
        assert_eq!(body["error"], "released");
        assert_eq!(body["released_at"], "2026-01-01T00:00:00Z");
        assert_eq!(body["available_at"], "2026-01-31T00:00:00Z");
    }

    #[test]
    fn internal_carries_message() {
        let err = ApiError::Internal("disk on fire".into());
        assert_eq!(err.message(), "disk on fire");
        assert_eq!(err.body()["message"], "disk on fire");
    }

    #[test]
    fn responder_emits_json_with_status() {
        let client = Client::tracked(rocket::build().mount("/", routes![boom])).unwrap();
        let resp = client.get("/boom").dispatch();
        assert_eq!(resp.status(), Status::Conflict);
        assert_eq!(resp.content_type(), Some(ContentType::JSON));
        let body: serde_json::Value = serde_json::from_str(&resp.into_string().unwrap()).unwrap();
        assert_eq!(body["error"], "handle_taken");
        assert_eq!(body["message"], "Handle is already registered");
    }
}
