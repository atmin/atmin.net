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
//! Two in-process TTL caches (`DeviceCache`/`ProfileCache`, mirroring Go's
//! `deviceCache`/`profileCache`) keep the hot path off S3: a recently-seen device
//! skips the `HeadObject`, a recently-read profile skips the kv `GET`. Both
//! self-heal within their TTL and are invalidated explicitly by the mutating
//! handlers (device delete/revoke, rotate-keys).

use crate::cache::{DeviceCache, ProfileCache};
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
        let Some(device_cache) = req.rocket().state::<DeviceCache>() else {
            return deny(ApiError::Internal("device cache missing".into()));
        };
        let Some(profile_cache) = req.rocket().state::<ProfileCache>() else {
            return deny(ApiError::Internal("profile cache missing".into()));
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

        // Device revocation: the device file must still exist. Skip the HeadObject
        // when the device was seen within the cache TTL.
        let device_key = key_device(user_id.as_str(), device_id.as_str());
        if !device_cache.valid(&device_key) {
            match store.head_object(&device_key).await {
                Ok(()) => device_cache.set(&device_key),
                Err(StoreError::NotFound) => return deny(ApiError::DeviceRevoked),
                Err(_) => return deny(ApiError::Internal("device check failed".into())),
            }
        }

        // key_version check (ADR-0012): a token bound to a superseded kv means
        // another device rotated; the client must re-login at the current kv. The
        // profile cache short-circuits the S3 GET on a fresh hit.
        let current = match profile_cache.get(user_id.as_str()) {
            Some(kv) => kv,
            None => {
                let profile_bytes = match store.get_object(&key_profile(user_id.as_str())).await {
                    Ok(b) => b,
                    Err(StoreError::NotFound) => return deny(ApiError::Unauthorized),
                    Err(_) => return deny(ApiError::Internal("profile load failed".into())),
                };
                let Ok(profile) = serde_json::from_slice::<Profile>(&profile_bytes) else {
                    return deny(ApiError::Internal("profile parse failed".into()));
                };
                // Defensive: every profile now carries key_version >= 1; treat 0 as 1.
                let kv = if profile.key_version == 0 {
                    1
                } else {
                    profile.key_version
                };
                profile_cache.set(user_id.as_str(), kv);
                kv
            }
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
