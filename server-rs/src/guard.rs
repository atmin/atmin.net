//! The `AuthedUser` request guard — Rocket's equivalent of `requireAuth`
//! (`server/middleware.go`). A handler that takes `AuthedUser` (in practice
//! `Result<AuthedUser, ApiError>`, then `?`) cannot do authenticated work without
//! a valid, non-revoked, current-`key_version` token.
//!
//! Checks, mirroring requireAuth:
//!   1. token from `Authorization: Bearer …`, else the `?token=` query param;
//!   2. HMAC parse → `(UserId, DeviceId, KeyVersion)`;
//!   3. device-revocation: the device file must still exist;
//!   4. `key_version`: the token's kv must equal the profile's current kv (ADR-0012).
//!
//! The in-process TTL caches Go uses (`deviceCache`/`profileCache`) are a perf
//! optimization, deferred to phase 5 — here every request hits the store.

use crate::config::ServerConfig;
use crate::error::ApiError;
use crate::model::{DeviceId, KeyVersion, UserId};
use crate::paths::{key_device, key_profile};
use crate::profile::Profile;
use crate::store::{SharedStore, StoreError};
use crate::token;
use rocket::request::{FromRequest, Outcome};
use rocket::Request;

#[derive(Debug, Clone)]
pub struct AuthedUser {
    pub user_id: UserId,
    pub device_id: DeviceId,
    pub key_version: KeyVersion,
}

fn deny(e: ApiError) -> Outcome<AuthedUser, ApiError> {
    Outcome::Error((e.status(), e))
}

#[rocket::async_trait]
impl<'r> FromRequest<'r> for AuthedUser {
    type Error = ApiError;

    async fn from_request(req: &'r Request<'_>) -> Outcome<AuthedUser, ApiError> {
        let Some(config) = req.rocket().state::<ServerConfig>() else {
            return deny(ApiError::Internal("server config missing".into()));
        };
        let Some(store) = req.rocket().state::<SharedStore>() else {
            return deny(ApiError::Internal("store missing".into()));
        };

        // Token: `Authorization: Bearer …`, falling back to `?token=`.
        let token = req
            .headers()
            .get_one("Authorization")
            .and_then(|h| h.strip_prefix("Bearer "))
            .map(str::to_string)
            .or_else(|| req.query_value::<String>("token").and_then(Result::ok));
        let Some(token) = token else {
            return deny(ApiError::Unauthorized);
        };

        let Ok((uid, did, token_kv)) = token::parse(&config.server_secret, &token) else {
            return deny(ApiError::Unauthorized);
        };
        // A valid HMAC over a non-ULID id can't happen, but reject cleanly if so.
        let (Ok(user_id), Ok(device_id)) = (UserId::new(uid), DeviceId::new(did)) else {
            return deny(ApiError::Unauthorized);
        };

        // Device revocation: the device file must still exist.
        match store
            .head_object(&key_device(user_id.as_str(), device_id.as_str()))
            .await
        {
            Ok(()) => {}
            Err(StoreError::NotFound) => return deny(ApiError::DeviceRevoked),
            Err(_) => return deny(ApiError::Internal("device check failed".into())),
        }

        // key_version check (ADR-0012): a token bound to a superseded kv means
        // another device rotated; the client must re-login at the current kv.
        let profile_bytes = match store.get_object(&key_profile(user_id.as_str())).await {
            Ok(b) => b,
            Err(StoreError::NotFound) => return deny(ApiError::Unauthorized),
            Err(_) => return deny(ApiError::Internal("profile load failed".into())),
        };
        let Ok(profile) = serde_json::from_slice::<Profile>(&profile_bytes) else {
            return deny(ApiError::Internal("profile parse failed".into()));
        };
        // Defensive: every profile now carries key_version >= 1; treat 0 as 1.
        let current = if profile.key_version == 0 {
            1
        } else {
            profile.key_version
        };
        if token_kv.get() != current {
            return deny(ApiError::KeyVersionStale {
                current: KeyVersion::new(current).unwrap_or(KeyVersion::ONE),
            });
        }

        Outcome::Success(AuthedUser {
            user_id,
            device_id,
            key_version: token_kv,
        })
    }
}
