//! HTTP routes (Rocket). [`build`] wires the store, config, and in-process state
//! into a Rocket app and mounts every handler.

use crate::authproof::{verify, verify_proof, AuthProof};
use crate::cache::{DeviceCache, ProfileCache};
use crate::cbor;
use crate::config::ServerConfig;
use crate::error::ApiError;
use crate::events::{update_last_active, EventHub};
use crate::guard::{AuthedUser, AuthedUserNoKv};
use crate::idempotency::{load_rotation_record, save_rotation_record, RotationRecord};
use crate::keyed_mutex::KeyedMutex;
use crate::media_quota::{
    InProcessMediaQuota, Reservation, SharedQuota, MAX_MEDIA_BYTES, USER_MEDIA_BLOB_CAP,
    USER_MEDIA_QUOTA_BYTES,
};
use crate::model::{DeviceId, Handle, KeyVersion, UserId};
use crate::paths::{
    authorize_key, authorize_key_write, authorize_prefix, is_object_name_safe, key_device,
    key_handle, key_inbox_live, key_profile, key_rotation_record, prefix_inbox, prefix_keys,
    prefix_media, prefix_user, prefix_user_devices,
};
use crate::profile::{valid_kdf_params, KdfParams, Profile, PublicHandleData};
use crate::reserved;
use crate::store::{SharedStore, StoreError};
use crate::token;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ciborium::value::Value;
use rocket::http::{ContentType, Status};
use rocket::response::stream::{Event, EventStream};
use rocket::response::Responder;
use rocket::serde::json::Json;
use rocket::serde::{Deserialize, Serialize};
use rocket::{delete, get, post, put, routes, Build, Request, Response, Rocket, Shutdown, State};
use serde_json::value::RawValue;
use std::collections::BTreeSet;
use std::io::Cursor;
use std::sync::Arc;
use std::time::Duration as StdDuration;
use ulid::Ulid;

/// Post-deletion handle reservation window (ADR-0013).
const HANDLE_COOLDOWN_DAYS: i64 = 30;

/// Default page size for `GET /v1/store/list`.
const STORE_LIST_LIMIT: usize = 50;

/// How long `register` waits for the per-handle claim lock before giving up with
/// `registration_unavailable`.
const HANDLE_CLAIM_TIMEOUT: StdDuration = StdDuration::from_millis(500);

/// Per-handle claim lock (keyed by handle), serializing `register`'s GET-then-PUT
/// so two concurrent registrations of the same handle can't both see it free. A
/// newtype because Rocket manages state by type and a second `KeyedMutex` (the
/// rotation lock) is coming.
struct HandleClaimMutex(KeyedMutex);

/// How long `rotate-keys` waits for the per-uid lock before giving up. Two
/// genuinely-concurrent rotations from one user are degenerate.
const ROTATION_TIMEOUT: StdDuration = StdDuration::from_millis(500);

/// Per-uid rotation lock, serializing the GET-VERIFY-WRITE on `profile.json`
/// (ADR-0012). Distinct newtype from [`HandleClaimMutex`] so a handler can't grab
/// the wrong lock.
struct RotationMutex(KeyedMutex);

/// Build the Rocket app over a given store + config. Tests pass a `MemStore`;
/// production will pass an S3-backed store.
pub fn build(store: SharedStore, config: ServerConfig) -> Rocket<Build> {
    // One shared quota instance across presign (reserve) and delete (invalidate),
    // so the delete path expires the same cached usage.
    let quota: SharedQuota = Arc::new(InProcessMediaQuota::new(store.clone()));
    let app = rocket::build()
        .manage(store)
        .manage(config)
        .manage(quota)
        .manage(DeviceCache::new())
        .manage(ProfileCache::new())
        .manage(EventHub::new())
        .manage(HandleClaimMutex(KeyedMutex::new()))
        .manage(RotationMutex(KeyedMutex::new()))
        .mount(
            "/",
            routes![
                healthz,
                resolve,
                register,
                add_device,
                store_list,
                store_usage,
                store_object,
                delete_object,
                store_presign,
                store_compact,
                update_profile,
                delete_profile,
                delete_device,
                revoke_device,
                send,
                rotate_keys,
                events
            ],
        );

    // Embedded SPA as the catch-all (ranked last) — only with the feature, so the
    // default build/test gate stays free of a web-dist dependency.
    #[cfg(feature = "embed-spa")]
    let app = app.mount("/", routes![crate::spa::spa]);

    app
}

#[get("/healthz")]
fn healthz() -> &'static str {
    "ok"
}

/// `GET /v1/resolve/{handle}` — public handle lookup.
#[get("/v1/resolve/<handle>")]
async fn resolve(
    handle: &str,
    store: &State<SharedStore>,
) -> Result<Json<PublicHandleData>, ApiError> {
    // NotFound → 404; any other backend error → 500 (via From<StoreError>).
    let data = store.get_object(&key_handle(handle)).await?;
    let h: PublicHandleData = serde_json::from_slice(&data)
        .map_err(|_| ApiError::Internal("Failed to parse handle projection".into()))?;

    if !h.released_at.is_empty() {
        // Tombstone: a deleted handle, in or past its cooldown window.
        let Ok(released) = DateTime::parse_from_rfc3339(&h.released_at) else {
            // Corrupt tombstone — 404 rather than leak the malformed value.
            return Err(ApiError::NotFound);
        };
        let available = released.with_timezone(&Utc) + Duration::days(HANDLE_COOLDOWN_DAYS);
        if Utc::now() < available {
            return Err(ApiError::HandleReleased {
                released_at: h.released_at,
                available_at: available.to_rfc3339_opts(SecondsFormat::Secs, true),
            });
        }
        // Stale tombstone (cooldown elapsed, cleanup pending) — logically free → 404.
        return Err(ApiError::NotFound);
    }

    // No backfill from profile.json for missing projection fields
    // (sharing_public_key / salt / kdf): projections are written complete, so an
    // incomplete one can't arise.

    Ok(Json(h))
}

#[derive(Serialize)]
struct StoreListResponse {
    keys: Vec<String>,
    /// Empty string when there are no more pages.
    next_cursor: String,
}

/// `GET /v1/store/list` — authed listing of keys under a prefix the caller owns.
/// The first endpoint behind the `AuthedUser` guard.
#[get("/v1/store/list?<prefix>&<cursor>")]
async fn store_list(
    auth: Result<AuthedUser, ApiError>,
    prefix: Option<&str>,
    cursor: Option<&str>,
    store: &State<SharedStore>,
) -> Result<Json<StoreListResponse>, ApiError> {
    let user = auth?;
    let prefix = prefix
        .filter(|p| !p.is_empty())
        .ok_or(ApiError::BadRequest)?;
    if !authorize_prefix(user.user_id.as_str(), prefix) {
        return Err(ApiError::Forbidden);
    }
    let cursor = cursor.filter(|c| !c.is_empty());
    let page = store.list_objects(prefix, STORE_LIST_LIMIT, cursor).await?;
    Ok(Json(StoreListResponse {
        keys: page.keys,
        next_cursor: page.next_cursor.unwrap_or_default(),
    }))
}

/// Raw-bytes response for a stored object (octet-stream). Media blobs carry a
/// long immutable `Cache-Control` — the bytes are GCM ciphertext, so even shared
/// caching of an `Authorization`-bearing request is safe (RFC 9111 §3.5).
struct ObjectResponse {
    data: Vec<u8>,
    cacheable: bool,
}

impl<'r> Responder<'r, 'static> for ObjectResponse {
    fn respond_to(self, _: &'r Request<'_>) -> rocket::response::Result<'static> {
        let mut builder = Response::build();
        builder.header(ContentType::Binary);
        if self.cacheable {
            builder.raw_header("Cache-Control", "public, immutable, max-age=31536000");
        }
        builder.sized_body(self.data.len(), Cursor::new(self.data));
        builder.ok()
    }
}

/// `GET /v1/store/object` — authed fetch of a single object the caller may read.
#[get("/v1/store/object?<key>")]
async fn store_object(
    auth: Result<AuthedUser, ApiError>,
    key: Option<&str>,
    store: &State<SharedStore>,
) -> Result<ObjectResponse, ApiError> {
    let user = auth?;
    let key = key.filter(|k| !k.is_empty()).ok_or(ApiError::BadRequest)?;
    if !authorize_key(user.user_id.as_str(), key) {
        return Err(ApiError::Forbidden);
    }
    let data = store.get_object(key).await?; // NotFound → 404 via From<StoreError>
    Ok(ObjectResponse {
        data,
        cacheable: key.starts_with("media/"),
    })
}

#[derive(Serialize)]
struct StoreUsageResponse {
    used_bytes: u64,
    quota_bytes: u64,
    blob_count: usize,
    quota_blob_cap: usize,
}

/// `GET /v1/store/usage` — the caller's media usage from the quota cache (re-probing
/// S3 on a miss). No prefix authorization: implicitly scoped to the authenticated
/// user, takes no key, read-only.
#[get("/v1/store/usage")]
async fn store_usage(
    auth: Result<AuthedUser, ApiError>,
    quota: &State<SharedQuota>,
) -> Result<Json<StoreUsageResponse>, ApiError> {
    let user = auth?;
    let (used, count) = quota.get_usage(user.user_id.as_str()).await?;
    Ok(Json(StoreUsageResponse {
        used_bytes: used,
        quota_bytes: USER_MEDIA_QUOTA_BYTES,
        blob_count: count,
        quota_blob_cap: USER_MEDIA_BLOB_CAP,
    }))
}

/// `DELETE /v1/store/object` — owner-only delete (unlike the capability-protected
/// GET). Idempotent. On a media delete the user's cached quota usage is
/// invalidated (the handler has only the key, not the byte size, so it can't
/// decrement precisely — the next access re-probes S3).
#[delete("/v1/store/object?<key>")]
async fn delete_object(
    auth: Result<AuthedUser, ApiError>,
    key: Option<&str>,
    store: &State<SharedStore>,
    quota: &State<SharedQuota>,
) -> Result<(), ApiError> {
    let user = auth?;
    let key = key.filter(|k| !k.is_empty()).ok_or(ApiError::BadRequest)?;
    if !authorize_key_write(user.user_id.as_str(), key) {
        return Err(ApiError::Forbidden);
    }
    store.delete_object(key).await?;
    if key.starts_with("media/") {
        quota.invalidate(user.user_id.as_str()).await;
    }
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct PresignRequest {
    key: String,
    bytes: i64,
}

#[derive(Serialize)]
struct PresignResponse {
    presigned_url: String,
}

/// `POST /v1/store/presign` — issue a presigned PUT URL for a key the caller owns.
/// Media keys are size-checked (per-blob cap) and quota-reserved before signing.
#[post("/v1/store/presign", data = "<body>")]
async fn store_presign(
    auth: Result<AuthedUser, ApiError>,
    body: &str,
    store: &State<SharedStore>,
    quota: &State<SharedQuota>,
) -> Result<Json<PresignResponse>, ApiError> {
    let user = auth?;
    let req: PresignRequest = serde_json::from_str(body).map_err(|_| ApiError::BadRequest)?;
    if req.key.is_empty() || req.bytes <= 0 {
        return Err(ApiError::BadRequest);
    }
    if !authorize_key_write(user.user_id.as_str(), &req.key) {
        return Err(ApiError::Forbidden);
    }
    // Belt for a future client bug: reject object-name-unsafe keys here (a clear
    // 400 at the API) rather than letting the eventual S3 PUT fail opaquely (I10).
    if !is_object_name_safe(&req.key) {
        return Err(ApiError::BadRequest);
    }
    let bytes = req.bytes as u64;
    if req.key.starts_with("media/") {
        if bytes > MAX_MEDIA_BYTES {
            return Err(ApiError::TooLarge);
        }
        match quota.reserve_upload(user.user_id.as_str(), bytes).await? {
            Reservation::Granted => {}
            Reservation::DeniedBytes | Reservation::DeniedCount => {
                return Err(ApiError::QuotaExceeded)
            }
        }
    }

    let url = store
        .presign_put(&req.key, bytes, StdDuration::from_secs(15 * 60))
        .await?;
    Ok(Json(PresignResponse { presigned_url: url }))
}

/// Serialize `value` as JSON and store it. Serialization failure → 500.
async fn write_json<T: Serialize>(
    store: &SharedStore,
    key: &str,
    value: &T,
) -> Result<(), ApiError> {
    let bytes =
        serde_json::to_vec(value).map_err(|_| ApiError::Internal("serialize failed".into()))?;
    store.put_object(key, &bytes, "application/json").await?;
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RegisterRequest {
    handle: String,
    device_label: String,
    auth_public_key: String,
    sharing_public_key: String,
    salt: String,
    kdf: Option<KdfParams>,
}

#[derive(Serialize)]
struct RegisterResponse {
    user_id: String,
    device_id: String,
    token: String,
    handle: String,
}

/// `POST /v1/register` — create an account: claim a handle, mint ids + token,
/// write the handle projection + profile + device. Public.
#[post("/v1/register", data = "<body>")]
async fn register(
    body: &str,
    store: &State<SharedStore>,
    config: &State<ServerConfig>,
    handle_mu: &State<HandleClaimMutex>,
) -> Result<Json<RegisterResponse>, ApiError> {
    // Manual parse so malformed *and* missing-field bodies both yield 400 (matching Go).
    let req: RegisterRequest = serde_json::from_str(body).map_err(|_| ApiError::BadRequest)?;
    if req.handle.is_empty()
        || req.device_label.is_empty()
        || req.auth_public_key.is_empty()
        || req.sharing_public_key.is_empty()
    {
        return Err(ApiError::BadRequest);
    }

    // Handle: charset/length (→ handle_invalid), then reserved-list (→ handle_reserved).
    let handle = Handle::new(&req.handle).map_err(|_| ApiError::HandleInvalid)?;
    if reserved::is_reserved(handle.as_str()) {
        return Err(ApiError::HandleReserved);
    }

    // Credential params mandatory (ADR-0016 floor): salt + Argon2id kdf.
    let Some(kdf) = req.kdf.as_ref() else {
        return Err(ApiError::BadRequest);
    };
    if req.salt.is_empty() || !valid_kdf_params(&req.salt, kdf) {
        return Err(ApiError::BadRequest);
    }

    // Claim the handle under the per-handle lock (ADR-0013). Held to the end of
    // the handler (the RAII guard drops on return), so the GET-then-PUT and the
    // projection/profile/device writes are all serialized against a concurrent
    // registration of the same handle. Timeout → 503 registration_unavailable.
    let _claim = handle_mu
        .0
        .acquire(handle.as_str(), HANDLE_CLAIM_TIMEOUT)
        .await
        .map_err(|_| ApiError::RegistrationUnavailable)?;

    let handle_key = key_handle(handle.as_str());
    match store.get_object(&handle_key).await {
        Err(StoreError::NotFound) => {} // free → proceed
        Err(e) => return Err(e.into()),
        Ok(existing) => {
            let h: PublicHandleData = serde_json::from_slice(&existing)
                .map_err(|_| ApiError::Internal("Failed to parse handle projection".into()))?;
            if h.released_at.is_empty() {
                return Err(ApiError::HandleTaken);
            }
            // Tombstone — branch on cooldown.
            let Ok(released) = DateTime::parse_from_rfc3339(&h.released_at) else {
                // Corrupt tombstone — treat as taken; an operator can investigate.
                return Err(ApiError::HandleTaken);
            };
            let available = released.with_timezone(&Utc) + Duration::days(HANDLE_COOLDOWN_DAYS);
            if Utc::now() < available {
                return Err(ApiError::HandleInCooldown {
                    released_at: h.released_at,
                    available_at: available.to_rfc3339_opts(SecondsFormat::Secs, true),
                });
            }
            // Stale tombstone — delete in-band so the PUT below replaces it cleanly.
            store.delete_object(&handle_key).await?;
        }
    }

    let user_id = Ulid::new().to_string();
    let device_id = Ulid::new().to_string();
    let token = token::generate(&config.server_secret, &user_id, &device_id, KeyVersion::ONE);
    let created_at = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);

    // Write order: handle projection FIRST (claims the name), then profile, then
    // device — best-effort rollback if a later write fails. The user_id is never
    // returned on failure, so an abandoned one is invisible.
    let projection = PublicHandleData {
        user_id: user_id.clone(),
        sharing_public_key: req.sharing_public_key.clone(),
        salt: req.salt.clone(),
        kdf: req.kdf.clone(),
        key_version: 1,
        ..Default::default()
    };
    write_json(store, &handle_key, &projection).await?;

    let profile = Profile {
        user_id: user_id.clone(),
        handle: req.handle.clone(),
        auth_public_key: req.auth_public_key.clone(),
        sharing_public_key: req.sharing_public_key.clone(),
        salt: req.salt.clone(),
        kdf: req.kdf.clone(),
        key_version: 1,
        created_at: created_at.clone(),
        ..Default::default()
    };
    if let Err(e) = write_json(store, &key_profile(&user_id), &profile).await {
        let _ = store.delete_object(&handle_key).await;
        return Err(e);
    }

    let device = serde_json::json!({
        "device_id": device_id,
        "device_label": req.device_label,
        "created_at": created_at,
    });
    if let Err(e) = write_json(store, &key_device(&user_id, &device_id), &device).await {
        let _ = store.delete_object(&handle_key).await;
        let _ = store.delete_object(&key_profile(&user_id)).await;
        return Err(e);
    }

    Ok(Json(RegisterResponse {
        user_id,
        device_id,
        token,
        handle: req.handle,
    }))
}

#[derive(Deserialize)]
struct AddDeviceRequest {
    #[serde(default)]
    user_id: String,
    auth_proof: AuthProof,
    #[serde(default)]
    device_label: String,
}

#[derive(Serialize)]
struct AddDeviceResponse {
    device_id: String,
    token: String,
}

/// `POST /v1/devices` — the returning-device flow: verify a signed auth proof
/// against the account, then write a new device file and issue a token. Public
/// (the proof *is* the credential).
#[post("/v1/devices", data = "<body>")]
async fn add_device(
    body: &str,
    store: &State<SharedStore>,
    config: &State<ServerConfig>,
) -> Result<Json<AddDeviceResponse>, ApiError> {
    let req: AddDeviceRequest = serde_json::from_str(body).map_err(|_| ApiError::BadRequest)?;
    let user_id = UserId::new(&req.user_id).map_err(|_| ApiError::BadRequest)?;

    // Load the account; a missing profile → 404 (via From<StoreError>).
    let profile_bytes = store.get_object(&key_profile(user_id.as_str())).await?;
    let profile: Profile = serde_json::from_slice(&profile_bytes)
        .map_err(|_| ApiError::Internal("Failed to parse profile".into()))?;

    // Verify the proof against the account's auth public key. A malformed key,
    // bad signature, or stale timestamp is all a 403 (auth_proof_invalid).
    let pubkey = URL_SAFE_NO_PAD
        .decode(&profile.auth_public_key)
        .ok()
        .filter(|b| b.len() == 32)
        .ok_or(ApiError::Forbidden)?;
    let payload =
        verify_proof(&pubkey, &req.auth_proof, Utc::now()).map_err(|_| ApiError::Forbidden)?;

    // The proof is only valid against the account's current key_version.
    let current = if profile.key_version == 0 {
        1
    } else {
        profile.key_version
    };
    if payload.key_version != current {
        return Err(ApiError::KeyVersionStale {
            current: KeyVersion::new(current).unwrap_or(KeyVersion::ONE),
        });
    }

    // device_id comes from the signed payload; validate it's a ULID before using
    // it as an S3 key segment and token field.
    let device_id = DeviceId::new(&payload.device_id).map_err(|_| ApiError::BadRequest)?;
    let kv = KeyVersion::new(current).unwrap_or(KeyVersion::ONE);
    let token = token::generate(
        &config.server_secret,
        user_id.as_str(),
        device_id.as_str(),
        kv,
    );

    let device = serde_json::json!({
        "device_id": device_id.as_str(),
        "device_label": req.device_label,
        "created_at": Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
    });
    write_json(
        store,
        &key_device(user_id.as_str(), device_id.as_str()),
        &device,
    )
    .await?;

    Ok(Json(AddDeviceResponse {
        device_id: device_id.as_str().to_string(),
        token,
    }))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct CompactRequest {
    prefix: String,
    up_to: String,
}

#[derive(Serialize)]
struct CompactResponse {
    archived: usize,
    archive_key: String,
}

/// `POST /v1/store/compact` — merge live objects (≤ `prefix + up_to`) into a daily
/// CBOR archive, dedup by `msg_id`, then delete the live objects + merged-in
/// same-day archives.
///
/// Note: live objects are JSON; decoded here to `ciborium::Value`, so JSON
/// integers stay CBOR integers. An archive written via a JSON→float→CBOR path
/// would instead carry doubles, so a reader must tolerate both representations of
/// a number (see [`crate::cbor`]). Benign for clients, which already accept both.
#[post("/v1/store/compact", data = "<body>")]
async fn store_compact(
    auth: Result<AuthedUser, ApiError>,
    body: &str,
    store: &State<SharedStore>,
) -> Result<Json<CompactResponse>, ApiError> {
    let user = auth?;
    let req: CompactRequest = serde_json::from_str(body).map_err(|_| ApiError::BadRequest)?;
    if req.prefix.is_empty() || req.up_to.is_empty() {
        return Err(ApiError::BadRequest);
    }
    if !authorize_prefix(user.user_id.as_str(), &req.prefix) {
        return Err(ApiError::Forbidden);
    }

    // Collect live keys ≤ boundary (keys are lexicographically sorted, so once a
    // page ends past the boundary we can stop).
    let boundary = format!("{}{}", req.prefix, req.up_to);
    let mut to_compact: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = store
            .list_objects(&req.prefix, 100, cursor.as_deref())
            .await?;
        for k in &page.keys {
            if k.as_str() <= boundary.as_str() {
                to_compact.push(k.clone());
            }
        }
        let last_past = page
            .keys
            .last()
            .is_some_and(|k| k.as_str() > boundary.as_str());
        match page.next_cursor {
            Some(c) if !last_past => cursor = Some(c),
            _ => break,
        }
    }

    if to_compact.is_empty() {
        return Ok(Json(CompactResponse {
            archived: 0,
            archive_key: String::new(),
        }));
    }

    // Read live objects (JSON → Value), skipping any deleted between list and get.
    let mut new_objects: Vec<Value> = Vec::new();
    for key in &to_compact {
        match store.get_object(key).await {
            Ok(data) => new_objects.push(
                serde_json::from_slice(&data)
                    .map_err(|_| ApiError::Internal("decode failed".into()))?,
            ),
            Err(StoreError::NotFound) => continue,
            Err(e) => return Err(e.into()),
        }
    }

    // Same-day archive prefix is the sibling of live/: …/live/ → …/archive/.
    let today = Utc::now().format("%Y-%m-%d").to_string();
    let archive_base = format!(
        "{}archive/",
        req.prefix.strip_suffix("live/").unwrap_or(&req.prefix)
    );
    let archive_prefix = format!("{archive_base}{today}");

    // List, then read + decode, the existing same-day archives to merge with.
    let mut existing_archive_keys: Vec<String> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = store
            .list_objects(&archive_prefix, 100, cursor.as_deref())
            .await?;
        existing_archive_keys.extend(page.keys);
        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    let mut existing_objects: Vec<Value> = Vec::new();
    for key in &existing_archive_keys {
        match store.get_object(key).await {
            Ok(data) => existing_objects.extend(
                cbor::decode_archive(&data)
                    .map_err(|_| ApiError::Internal("CBOR decode failed".into()))?,
            ),
            Err(StoreError::NotFound) => continue,
            Err(e) => return Err(e.into()),
        }
    }

    // Merge (existing first, preserving order), dedup by msg_id, encode.
    let archived = new_objects.len();
    let mut merged = existing_objects;
    merged.extend(new_objects);
    let merged = cbor::deduplicate_by_msg_id(merged);
    let archive = cbor::encode_archive(&merged)
        .map_err(|_| ApiError::Internal("CBOR encode failed".into()))?;

    // No object is deleted before the new archive is durably written.
    let archive_key = format!("{archive_base}{today}-{}", Ulid::new());
    store
        .put_object(&archive_key, &archive, "application/cbor")
        .await?;

    let mut to_delete = to_compact;
    to_delete.extend(existing_archive_keys);
    store.delete_objects(&to_delete).await?;

    Ok(Json(CompactResponse {
        archived,
        archive_key,
    }))
}

/// Build the public handle projection (`handles/{handle}.json`) from a profile.
fn handle_projection(p: &Profile) -> PublicHandleData {
    PublicHandleData {
        user_id: p.user_id.clone(),
        sharing_public_key: p.sharing_public_key.clone(),
        salt: p.salt.clone(),
        kdf: p.kdf.clone(),
        key_version: p.key_version,
        display_name: p.display_name.clone(),
        avatar_url: p.avatar_url.clone(),
        released_at: String::new(),
    }
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct ProfileUpdateRequest {
    display_name: Option<String>,
    avatar_url: Option<String>,
}

/// `PUT /v1/profile` — authed update of mutable profile fields, then re-project
/// the public fields to the handle file. A field absent or `null` means "leave
/// unchanged"; present (even `""`) means "set". At least one field is required.
#[put("/v1/profile", data = "<body>")]
async fn update_profile(
    auth: Result<AuthedUser, ApiError>,
    body: &str,
    store: &State<SharedStore>,
) -> Result<(), ApiError> {
    let user = auth?;
    let req: ProfileUpdateRequest = serde_json::from_str(body).map_err(|_| ApiError::BadRequest)?;
    if req.display_name.is_none() && req.avatar_url.is_none() {
        return Err(ApiError::BadRequest);
    }

    // Read-merge-write profile.json (missing → 404 via From<StoreError>).
    let key = key_profile(user.user_id.as_str());
    let profile_bytes = store.get_object(&key).await?;
    let mut profile: Profile = serde_json::from_slice(&profile_bytes)
        .map_err(|_| ApiError::Internal("Failed to parse profile".into()))?;
    if let Some(dn) = req.display_name {
        profile.display_name = dn;
    }
    if let Some(av) = req.avatar_url {
        profile.avatar_url = av;
    }
    write_json(store, &key, &profile).await?;

    // Re-project public fields. Best-effort — a projection failure does not fail
    // the update.
    if !profile.handle.is_empty() {
        let _ = write_json(
            store,
            &key_handle(&profile.handle),
            &handle_projection(&profile),
        )
        .await;
    }

    Ok(())
}

/// `DELETE /v1/profile` — wipe the account and leave the handle reserved. Reads
/// the profile for its handle (404 if gone), deletes every object under the
/// account's four owned prefixes (evicting the device cache for any device about
/// to vanish, so other signed-in devices are cut off now rather than at TTL), then
/// replaces the handle projection with a 30-day cooldown tombstone (ADR-0013)
/// under the *same* handle lock register uses.
#[delete("/v1/profile")]
async fn delete_profile(
    auth: Result<AuthedUser, ApiError>,
    store: &State<SharedStore>,
    handle_mu: &State<HandleClaimMutex>,
    device_cache: &State<DeviceCache>,
) -> Result<(), ApiError> {
    let user = auth?;
    let uid = user.user_id.as_str();

    // Read the profile for its handle (missing → 404 via From<StoreError>).
    let profile_bytes = store.get_object(&key_profile(uid)).await?;
    let profile: Profile = serde_json::from_slice(&profile_bytes)
        .map_err(|_| ApiError::Internal("Failed to read profile".into()))?;

    // Wipe every prefix the account owns (single 1000-key page each).
    let devices_prefix = prefix_user_devices(uid);
    for prefix in [
        prefix_user(uid),
        prefix_inbox(uid),
        prefix_keys(uid),
        prefix_media(uid),
    ] {
        let page = store
            .list_objects(&prefix, 1000, None)
            .await
            .map_err(|_| ApiError::Internal("Failed to list objects".into()))?;
        // Evict the device-existence cache for devices we're deleting, so other
        // signed-in devices 403 on their next request instead of lingering a TTL.
        for k in &page.keys {
            if k.starts_with(&devices_prefix) {
                device_cache.invalidate(k);
            }
        }
        if !page.keys.is_empty() {
            store
                .delete_objects(&page.keys)
                .await
                .map_err(|_| ApiError::Internal("Failed to delete objects".into()))?;
        }
    }

    // Replace the handle projection with a cooldown tombstone, serialized against
    // any in-flight registration of the same handle (contention → 503). The RAII
    // guard releases the lock when this block ends.
    if !profile.handle.is_empty() {
        let _claim = handle_mu
            .0
            .acquire(&profile.handle, HANDLE_CLAIM_TIMEOUT)
            .await
            .map_err(|_| ApiError::RegistrationUnavailable)?;
        let tombstone = PublicHandleData {
            released_at: Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true),
            ..Default::default()
        };
        write_json(store, &key_handle(&profile.handle), &tombstone)
            .await
            .map_err(|_| ApiError::Internal("Failed to write handle tombstone".into()))?;
    }

    Ok(())
}

/// `DELETE /v1/devices` — self-delete the *calling* device (token only, no proof).
/// Deletes the token's own device file and evicts its cache entry so it stops
/// authenticating immediately. Idempotent.
#[delete("/v1/devices")]
async fn delete_device(
    auth: Result<AuthedUser, ApiError>,
    store: &State<SharedStore>,
    device_cache: &State<DeviceCache>,
) -> Result<(), ApiError> {
    let user = auth?;
    let device_key = key_device(user.user_id.as_str(), user.device_id.as_str());
    store
        .delete_object(&device_key)
        .await
        .map_err(|_| ApiError::Internal("Failed to delete device".into()))?;
    device_cache.invalidate(&device_key);
    Ok(())
}

#[derive(Deserialize)]
struct RevokeDeviceRequest {
    #[serde(default)]
    device_id: String,
    /// Required — the account credential authorizing the revocation.
    auth_proof: AuthProof,
}

/// `POST /v1/devices/revoke` — revoke *any* of the account's devices, authorized by
/// an auth-proof (so a device holding the password can cut off a lost one). The
/// token gives the uid; the proof must verify against the account's current
/// key_version (stale → 401, invalid → 403); then the named device is deleted and
/// its cache entry evicted.
#[post("/v1/devices/revoke", data = "<body>")]
async fn revoke_device(
    auth: Result<AuthedUser, ApiError>,
    body: &str,
    store: &State<SharedStore>,
    device_cache: &State<DeviceCache>,
) -> Result<(), ApiError> {
    let user = auth?;
    let req: RevokeDeviceRequest = serde_json::from_str(body).map_err(|_| ApiError::BadRequest)?;

    // Verify the proof against the account (the token already gave us the uid).
    let profile_bytes = store
        .get_object(&key_profile(user.user_id.as_str()))
        .await?;
    let profile: Profile = serde_json::from_slice(&profile_bytes)
        .map_err(|_| ApiError::Internal("Failed to read profile".into()))?;
    let pubkey = URL_SAFE_NO_PAD
        .decode(&profile.auth_public_key)
        .ok()
        .filter(|b| b.len() == 32)
        .ok_or(ApiError::Forbidden)?;
    let payload =
        verify_proof(&pubkey, &req.auth_proof, Utc::now()).map_err(|_| ApiError::Forbidden)?;
    let current = if profile.key_version == 0 {
        1
    } else {
        profile.key_version
    };
    if payload.key_version != current {
        return Err(ApiError::KeyVersionStale {
            current: KeyVersion::new(current).unwrap_or(KeyVersion::ONE),
        });
    }

    // Revoke the named device (idempotent) and evict its cache entry.
    let device_key = key_device(user.user_id.as_str(), &req.device_id);
    store
        .delete_object(&device_key)
        .await
        .map_err(|_| ApiError::Internal("Failed to delete device".into()))?;
    device_cache.invalidate(&device_key);
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct SendRequest<'a> {
    #[serde(borrow)]
    envelopes: Vec<&'a RawValue>,
}

/// The sender-identity + routing fields read off each envelope; the rest of the
/// envelope is opaque ciphertext, stored verbatim.
#[derive(Deserialize, Default)]
#[serde(default)]
struct EnvelopeHeader {
    to_user: String,
    from_user: String,
    from_device: String,
    msg_id: String,
}

/// `POST /v1/send` — deliver encrypted envelopes to recipients' inboxes and notify
/// them over SSE. Each envelope's `from_user`/`from_device` must match the
/// authenticated token (else 403); the whole envelope is written
/// verbatim to `inbox/{to_user}/live/{msg_id}`. No authorization on `to_user` —
/// writing to any recipient's inbox is the point. Notifies each unique recipient
/// once with `new_message`.
#[post("/v1/send", data = "<body>")]
async fn send(
    auth: Result<AuthedUser, ApiError>,
    body: &str,
    store: &State<SharedStore>,
    hub: &State<EventHub>,
) -> Result<(), ApiError> {
    let user = auth?;
    let req: SendRequest = serde_json::from_str(body).map_err(|_| ApiError::BadRequest)?;

    let mut recipients: BTreeSet<String> = BTreeSet::new();
    for raw in &req.envelopes {
        let env: EnvelopeHeader =
            serde_json::from_str(raw.get()).map_err(|_| ApiError::BadRequest)?;
        // Sender identity must match the token (can't forge from_user/from_device).
        if env.from_user != user.user_id.as_str() || env.from_device != user.device_id.as_str() {
            return Err(ApiError::Forbidden);
        }
        // Write the envelope exactly as received (opaque ciphertext).
        store
            .put_object(
                &key_inbox_live(&env.to_user, &env.msg_id),
                raw.get().as_bytes(),
                "application/json",
            )
            .await?;
        recipients.insert(env.to_user);
    }

    for to in &recipients {
        hub.notify(to, "new_message");
    }
    Ok(())
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RotateKeysRequest {
    request_id: String,
    key_version: u32,
    auth_public_key: String,
    sharing_public_key: String,
    salt: String,
    kdf: Option<KdfParams>,
    continuity_signature: String,
}

/// The protocol-level result of a rotation — a distinct type from `ApiError`
/// because two of its cases carry a non-standard status: `key_version_stale` is a
/// **409** here (a precondition failure), not the guard's 401, and every case is
/// persisted then replayed verbatim on a retried `request_id` (idempotency).
enum RotateOutcome {
    Success {
        token: String,
        key_version: u32,
    },
    /// Status 409; `current` is the account's kv, or `-1` when we lost the lock
    /// race and can't yet quote one.
    KeyVersionStale {
        current: i64,
    },
    /// 403 — the continuity signature didn't verify under the old auth key.
    BadContinuity,
}

impl RotateOutcome {
    /// The persisted form for idempotent replay.
    fn to_record(&self) -> RotationRecord {
        match self {
            RotateOutcome::Success { token, key_version } => RotationRecord {
                status: 200,
                token: Some(token.clone()),
                key_version: Some(*key_version),
                error: None,
                current: None,
            },
            RotateOutcome::KeyVersionStale { current } => RotationRecord {
                status: 409,
                token: None,
                key_version: None,
                error: Some(
                    ApiError::KeyVersionStale {
                        current: KeyVersion::ONE,
                    }
                    .code()
                    .into(),
                ),
                current: Some(*current),
            },
            RotateOutcome::BadContinuity => RotationRecord {
                status: 403,
                token: None,
                key_version: None,
                error: Some(ApiError::BadContinuity.code().into()),
                current: None,
            },
        }
    }

    /// Reconstruct the outcome to replay from a stored record.
    fn from_record(rec: &RotationRecord) -> RotateOutcome {
        if (200..300).contains(&rec.status) {
            RotateOutcome::Success {
                token: rec.token.clone().unwrap_or_default(),
                key_version: rec.key_version.unwrap_or(1),
            }
        } else if rec.error.as_deref() == Some(ApiError::BadContinuity.code()) {
            RotateOutcome::BadContinuity
        } else {
            RotateOutcome::KeyVersionStale {
                current: rec.current.unwrap_or(-1),
            }
        }
    }
}

impl<'r> Responder<'r, 'static> for RotateOutcome {
    fn respond_to(self, _: &'r Request<'_>) -> rocket::response::Result<'static> {
        let (status, body) = match self {
            RotateOutcome::Success { token, key_version } => (
                Status::Ok,
                serde_json::json!({ "token": token, "key_version": key_version }),
            ),
            RotateOutcome::KeyVersionStale { current } => {
                let e = ApiError::KeyVersionStale {
                    current: KeyVersion::ONE,
                };
                (
                    Status::Conflict,
                    serde_json::json!({ "error": e.code(), "message": e.message(), "current": current }),
                )
            }
            RotateOutcome::BadContinuity => (
                Status::Forbidden,
                serde_json::json!({
                    "error": ApiError::BadContinuity.code(),
                    "message": ApiError::BadContinuity.message(),
                }),
            ),
        };
        let s = body.to_string();
        Response::build()
            .status(status)
            .header(ContentType::JSON)
            .sized_body(s.len(), Cursor::new(s))
            .ok()
    }
}

/// A canonical hex UUID (8-4-4-4-12). Dependency-free validation, no regex.
fn is_valid_request_id(s: &str) -> bool {
    let groups = [8usize, 4, 4, 4, 12];
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == groups.len()
        && parts
            .iter()
            .zip(groups)
            .all(|(p, n)| p.len() == n && p.bytes().all(|b| b.is_ascii_hexdigit()))
}

/// Whether `b64` base64url-decodes to exactly `want_len` bytes: 32 for the
/// Ed25519 auth key, 65 for the P-256 sharing key.
fn valid_public_key(b64: &str, want_len: usize) -> bool {
    matches!(URL_SAFE_NO_PAD.decode(b64), Ok(b) if b.len() == want_len)
}

/// `POST /v1/rotate-keys` — advance the account credential to `key_version` =
/// current+1, proven by a continuity signature from the *old* auth key. Uses
/// `AuthedUserNoKv` so the just-superseded token still authenticates; serialized
/// per-uid by the rotation lock; idempotent on `request_id`.
#[post("/v1/rotate-keys", data = "<body>")]
async fn rotate_keys(
    auth: Result<AuthedUserNoKv, ApiError>,
    body: &str,
    store: &State<SharedStore>,
    config: &State<ServerConfig>,
    profile_cache: &State<ProfileCache>,
    rotation_mu: &State<RotationMutex>,
) -> Result<RotateOutcome, ApiError> {
    let AuthedUserNoKv(user) = auth?;

    let req: RotateKeysRequest = serde_json::from_str(body).map_err(|_| ApiError::BadRequest)?;
    if !is_valid_request_id(&req.request_id) {
        return Err(ApiError::BadRequest);
    }
    // Validate the new credential params up front, before touching the lock/store.
    let Some(kdf) = req.kdf.as_ref() else {
        return Err(ApiError::BadRequest);
    };
    if req.salt.is_empty() || !valid_kdf_params(&req.salt, kdf) {
        return Err(ApiError::BadRequest);
    }
    if !valid_public_key(&req.auth_public_key, 32) || !valid_public_key(&req.sharing_public_key, 65)
    {
        return Err(ApiError::BadRequest);
    }
    if req.continuity_signature.is_empty() {
        return Err(ApiError::BadRequest);
    }

    let uid = user.user_id.as_str();
    let record_key = key_rotation_record(uid, &req.request_id);

    // 1. Serialize per uid. Losing the race → 409 current=-1, no record written.
    let _lock = match rotation_mu.0.acquire(uid, ROTATION_TIMEOUT).await {
        Ok(g) => g,
        Err(_) => return Ok(RotateOutcome::KeyVersionStale { current: -1 }),
    };

    // 2. Idempotent replay (a load failure is treated as a miss).
    if let Ok(Some(rec)) = load_rotation_record(store, &record_key).await {
        return Ok(RotateOutcome::from_record(&rec));
    }

    // 3. Current profile.
    let profile_bytes = store
        .get_object(&key_profile(uid))
        .await
        .map_err(|_| ApiError::Internal("Failed to read profile".into()))?;
    let mut profile: Profile = serde_json::from_slice(&profile_bytes)
        .map_err(|_| ApiError::Internal("Failed to read profile".into()))?;
    let current_kv = if profile.key_version == 0 {
        1
    } else {
        profile.key_version
    };

    // 4. key_version precondition: must advance by exactly one.
    if req.key_version != current_kv + 1 {
        let outcome = RotateOutcome::KeyVersionStale {
            current: i64::from(current_kv),
        };
        let _ = save_rotation_record(store, &record_key, &outcome.to_record()).await;
        return Ok(outcome);
    }

    // 5. Continuity signature over JCS(signed fields), verified with the OLD key.
    let old_pub = URL_SAFE_NO_PAD
        .decode(&profile.auth_public_key)
        .ok()
        .filter(|b| b.len() == 32)
        .ok_or_else(|| ApiError::Internal("Stored auth_public_key is malformed".into()))?;
    let signed = serde_json::json!({
        "request_id": req.request_id,
        "key_version": req.key_version,
        "auth_public_key": req.auth_public_key,
        "sharing_public_key": req.sharing_public_key,
        "salt": req.salt,
        "kdf": req.kdf,
    });
    let signed_bytes = serde_json::to_vec(&signed)
        .map_err(|_| ApiError::Internal("canonicalize failed".into()))?;
    let sig_ok = URL_SAFE_NO_PAD
        .decode(&req.continuity_signature)
        .ok()
        .is_some_and(|sig| verify(&old_pub, &signed_bytes, &sig).is_ok());
    if !sig_ok {
        let outcome = RotateOutcome::BadContinuity;
        let _ = save_rotation_record(store, &record_key, &outcome.to_record()).await;
        return Ok(outcome);
    }

    // 6. Write the new profile (unconditional; the lock makes it atomic for uid).
    profile.auth_public_key = req.auth_public_key.clone();
    profile.sharing_public_key = req.sharing_public_key.clone();
    profile.salt = req.salt.clone();
    profile.kdf = req.kdf.clone();
    profile.key_version = req.key_version;
    write_json(store, &key_profile(uid), &profile)
        .await
        .map_err(|_| ApiError::Internal("Failed to write profile".into()))?;

    // 7. Refresh the resolve projection (best-effort — the profile is authoritative).
    if !profile.handle.is_empty() {
        let _ = write_json(
            store,
            &key_handle(&profile.handle),
            &handle_projection(&profile),
        )
        .await;
    }

    // 8. Mint a token bound to the new key_version.
    let kv = KeyVersion::new(req.key_version).unwrap_or(KeyVersion::ONE);
    let token = token::generate(&config.server_secret, uid, user.device_id.as_str(), kv);

    // 9. Record success for idempotent replay (best-effort: rotation already applied).
    let outcome = RotateOutcome::Success {
        token,
        key_version: req.key_version,
    };
    let _ = save_rotation_record(store, &record_key, &outcome.to_record()).await;

    // 10. Invalidate the cached kv so the next authed request sees the new one.
    profile_cache.invalidate(uid);

    Ok(outcome)
}

/// `GET /v1/events` — Server-Sent Events stream of real-time notifications for the
/// authenticated user. The token arrives via `?token=` (EventSource can't set an
/// `Authorization` header); the guard already accepts it there.
///
/// Rocket emits its own periodic heartbeat comment (every 30s) to hold the
/// connection open. On client disconnect the stream future drops, dropping the
/// `Subscription`, which unregisters from the hub.
///
/// TODO: defeat proxy buffering with `Cache-Control: no-cache` and
/// `X-Accel-Buffering: no`. Rocket's `EventStream` responder doesn't expose header
/// injection; revisit if a buffering proxy (e.g. Scaleway) is put in front.
#[get("/v1/events")]
async fn events(
    auth: Result<AuthedUser, ApiError>,
    hub: &State<EventHub>,
    store: &State<SharedStore>,
    mut shutdown: Shutdown,
) -> Result<EventStream![Event], ApiError> {
    let user = auth?;
    let mut sub = hub.register(user.user_id.as_str());

    // Refresh last_active in a detached task — background metadata that must not
    // delay or fail the stream.
    let store: SharedStore = store.inner().clone();
    let uid = user.user_id.as_str().to_owned();
    rocket::tokio::spawn(async move {
        update_last_active(&store, &uid).await;
    });

    let stream = EventStream! {
        // Initial `connected` event so the client knows the stream is live.
        yield Event::data("{}").event("connected");
        loop {
            rocket::tokio::select! {
                maybe = sub.recv() => match maybe {
                    Some(ev) => yield Event::data("{}").event(ev),
                    None => break, // hub side gone
                },
                _ = &mut shutdown => break, // graceful shutdown
            }
        }
    };
    Ok(stream.heartbeat(StdDuration::from_secs(30)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::KeyVersion;
    use crate::paths::{key_device, key_profile};
    use crate::profile::{KdfParams, Profile};
    use crate::store::Store;
    use crate::store_mem::MemStore;
    use crate::token;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine;
    use rocket::http::{Header, Status};
    use rocket::local::asynchronous::Client;
    use std::sync::Arc;

    const TEST_SECRET: &[u8] = b"test-server-secret";
    const UID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const DID: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

    fn config() -> ServerConfig {
        ServerConfig {
            server_secret: TEST_SECRET.to_vec(),
        }
    }

    async fn client_with(store: MemStore) -> Client {
        Client::tracked(build(Arc::new(store), config()))
            .await
            .unwrap()
    }

    async fn put_json<T: Serialize>(store: &MemStore, key: &str, value: &T) {
        store
            .put_object(key, &serde_json::to_vec(value).unwrap(), "application/json")
            .await
            .unwrap();
    }

    /// Seed a valid account (profile at `kv` + device file) and return a matching token.
    async fn seed_account(store: &MemStore, kv: u32) -> String {
        let profile = Profile {
            user_id: UID.into(),
            key_version: kv,
            ..Default::default()
        };
        put_json(store, &key_profile(UID), &profile).await;
        store
            .put_object(&key_device(UID, DID), b"{}", "application/json")
            .await
            .unwrap();
        token::generate(TEST_SECRET, UID, DID, KeyVersion::new(kv).unwrap())
    }

    fn bearer(token: &str) -> Header<'static> {
        Header::new("Authorization", format!("Bearer {token}"))
    }

    // --- resolve (public) ---

    #[tokio::test]
    async fn healthz_ok() {
        let client = client_with(MemStore::new()).await;
        let resp = client.get("/healthz").dispatch().await;
        assert_eq!(resp.status(), Status::Ok);
        assert_eq!(resp.into_string().await.unwrap(), "ok");
    }

    #[tokio::test]
    async fn resolve_missing_is_404() {
        let client = client_with(MemStore::new()).await;
        let resp = client.get("/v1/resolve/nobody").dispatch().await;
        assert_eq!(resp.status(), Status::NotFound);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(body["error"], "not_found");
    }

    #[tokio::test]
    async fn resolve_live_handle_returns_projection() {
        let store = MemStore::new();
        let projection = PublicHandleData {
            user_id: UID.into(),
            sharing_public_key: "BHFhpY".into(),
            salt: "c2FsdA".into(),
            kdf: Some(KdfParams {
                kind: "argon2id".into(),
                m: 65536,
                t: 3,
                p: 1,
            }),
            key_version: 1,
            ..Default::default()
        };
        put_json(&store, &key_handle("alice"), &projection).await;

        let client = client_with(store).await;
        let resp = client.get("/v1/resolve/alice").dispatch().await;
        assert_eq!(resp.status(), Status::Ok);
        let got: PublicHandleData =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(got, projection);
    }

    #[tokio::test]
    async fn resolve_tombstone_in_cooldown_is_410() {
        let store = MemStore::new();
        let tombstone = PublicHandleData {
            released_at: "2099-01-01T00:00:00Z".into(),
            ..Default::default()
        };
        put_json(&store, &key_handle("gone"), &tombstone).await;

        let client = client_with(store).await;
        let resp = client.get("/v1/resolve/gone").dispatch().await;
        assert_eq!(resp.status(), Status::Gone);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(body["error"], "released");
        assert_eq!(body["released_at"], "2099-01-01T00:00:00Z");
        assert_eq!(body["available_at"], "2099-01-31T00:00:00Z");
    }

    #[tokio::test]
    async fn resolve_stale_tombstone_is_404() {
        let store = MemStore::new();
        let tombstone = PublicHandleData {
            released_at: "2020-01-01T00:00:00Z".into(),
            ..Default::default()
        };
        put_json(&store, &key_handle("old"), &tombstone).await;

        let client = client_with(store).await;
        let resp = client.get("/v1/resolve/old").dispatch().await;
        assert_eq!(resp.status(), Status::NotFound);
    }

    // --- store/list (authed — exercises the AuthedUser guard) ---

    #[tokio::test]
    async fn store_list_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let uri = format!("/v1/store/list?prefix=inbox/{UID}/live/");
        let resp = client.get(uri.as_str()).dispatch().await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn store_list_rejects_a_bad_token() {
        let client = client_with(MemStore::new()).await;
        let uri = format!("/v1/store/list?prefix=inbox/{UID}/live/");
        let resp = client
            .get(uri.as_str())
            .header(bearer("garbage"))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn store_list_revoked_device_is_403() {
        let store = MemStore::new();
        // Profile exists, but no device file → the device has been revoked.
        let profile = Profile {
            user_id: UID.into(),
            key_version: 1,
            ..Default::default()
        };
        put_json(&store, &key_profile(UID), &profile).await;
        let token = token::generate(TEST_SECRET, UID, DID, KeyVersion::ONE);

        let client = client_with(store).await;
        let uri = format!("/v1/store/list?prefix=inbox/{UID}/live/");
        let resp = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Forbidden);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(body["error"], "device_revoked");
    }

    #[tokio::test]
    async fn store_list_stale_key_version_is_401() {
        let store = MemStore::new();
        let _ = seed_account(&store, 2).await; // profile + device at kv=2
        let stale = token::generate(TEST_SECRET, UID, DID, KeyVersion::ONE); // kv=1

        let client = client_with(store).await;
        let uri = format!("/v1/store/list?prefix=inbox/{UID}/live/");
        let resp = client
            .get(uri.as_str())
            .header(bearer(&stale))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Unauthorized);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(body["error"], "key_version_stale");
        assert_eq!(body["current"], 2);
    }

    #[tokio::test]
    async fn store_list_other_users_prefix_is_403() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        // Try to list another account's inbox.
        let resp = client
            .get("/v1/store/list?prefix=inbox/01BX5ZZKBKACTAV9WEVGEMMVRZ/live/")
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Forbidden);
    }

    #[tokio::test]
    async fn store_list_happy_path_returns_keys() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        store
            .put_object(&format!("inbox/{UID}/live/m1"), b"{}", "application/json")
            .await
            .unwrap();
        store
            .put_object(&format!("inbox/{UID}/live/m2"), b"{}", "application/json")
            .await
            .unwrap();

        let client = client_with(store).await;
        let uri = format!("/v1/store/list?prefix=inbox/{UID}/live/");
        let resp = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(
            body["keys"],
            serde_json::json!([
                format!("inbox/{UID}/live/m1"),
                format!("inbox/{UID}/live/m2"),
            ])
        );
        assert_eq!(body["next_cursor"], "");
    }

    // --- guard TTL caches: prove they short-circuit S3 ---

    #[tokio::test]
    async fn device_cache_skips_revocation_within_ttl() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let uri = format!("/v1/store/list?prefix=inbox/{UID}/live/");

        // First authed request succeeds and caches the device's existence.
        let resp = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);

        // Revoke the device by deleting its file. Without the cache the next
        // request would 403; within the 30s TTL the HeadObject is skipped, so it
        // still succeeds — the delete handler invalidates the cache to close this
        // window.
        client
            .rocket()
            .state::<SharedStore>()
            .unwrap()
            .delete_object(&key_device(UID, DID))
            .await
            .unwrap();
        let resp = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
    }

    #[tokio::test]
    async fn profile_cache_skips_kv_check_within_ttl() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await; // token + profile at kv=1
        let client = client_with(store).await;
        let uri = format!("/v1/store/list?prefix=inbox/{UID}/live/");

        // First request caches current kv=1.
        let resp = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);

        // Bump the stored profile to kv=2. Without the cache the kv=1 token would
        // now be 401 key_version_stale; within the 5s TTL the cached kv=1 still
        // matches, so it succeeds until invalidation/expiry (rotate-keys
        // invalidates, wired in 5d).
        let profile = Profile {
            user_id: UID.into(),
            key_version: 2,
            ..Default::default()
        };
        client
            .rocket()
            .state::<SharedStore>()
            .unwrap()
            .put_object(
                &key_profile(UID),
                &serde_json::to_vec(&profile).unwrap(),
                "application/json",
            )
            .await
            .unwrap();
        let resp = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
    }

    // --- send (authed; writes inbox + SSE notify) ---

    /// A recipient uid distinct from the sender (UID). Any string works as an
    /// inbox target — send doesn't validate `to_user`.
    const RID: &str = "01BX5ZZKBKACTAV9WEVGEMMVRZ";

    fn send_body(to: &str, from_user: &str, from_device: &str, msg_id: &str) -> String {
        serde_json::json!({
            "envelopes": [{
                "to_user": to,
                "from_user": from_user,
                "from_device": from_device,
                "msg_id": msg_id,
                "ciphertext": "BHEf…",
            }]
        })
        .to_string()
    }

    #[tokio::test]
    async fn send_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let resp = client
            .post("/v1/send")
            .header(ContentType::JSON)
            .body(send_body(RID, UID, DID, "m1"))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn send_delivers_to_inbox_and_notifies_recipient() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await; // authed as UID/DID
        let client = client_with(store).await;

        // A connected recipient device, so we can observe the SSE notification.
        let hub = client.rocket().state::<EventHub>().unwrap().clone();
        let mut sub = hub.register(RID);

        let resp = client
            .post("/v1/send")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(send_body(RID, UID, DID, "m1"))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);

        // The envelope landed in the recipient's live inbox, verbatim.
        let stored = client
            .rocket()
            .state::<SharedStore>()
            .unwrap()
            .get_object(&format!("inbox/{RID}/live/m1"))
            .await
            .unwrap();
        let env: serde_json::Value = serde_json::from_slice(&stored).unwrap();
        assert_eq!(env["from_user"], UID);
        assert_eq!(env["ciphertext"], "BHEf…");

        // ...and the recipient was notified.
        assert_eq!(sub.recv().await, Some("new_message".into()));
    }

    #[tokio::test]
    async fn send_rejects_forged_sender() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        // from_user claims a different account than the token's UID.
        let resp = client
            .post("/v1/send")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(send_body(RID, RID, DID, "m1"))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Forbidden);
    }

    #[tokio::test]
    async fn send_bad_body_is_400() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let resp = client
            .post("/v1/send")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body("not json")
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::BadRequest);
    }

    // --- rotate-keys (authNoKV guard; continuity-signed; idempotent) ---

    const REQ_ID: &str = "11111111-1111-1111-1111-111111111111";

    /// The new credential a rotation moves to (valid lengths; content beyond length
    /// is unchecked). Returns (auth_b64, sharing_b64, salt_b64, kdf).
    fn new_keys() -> (String, String, String, serde_json::Value) {
        (
            URL_SAFE_NO_PAD.encode([1u8; 32]),
            URL_SAFE_NO_PAD.encode([4u8; 65]),
            URL_SAFE_NO_PAD.encode([0u8; 16]),
            serde_json::json!({ "type": "argon2id", "m": 65536, "t": 3, "p": 1 }),
        )
    }

    /// Seed an account at kv=1 whose auth key is `sk`'s public key (so a continuity
    /// signature by `sk` verifies). Returns a kv=1 token.
    async fn seed_for_rotation(store: &MemStore, sk: &ed25519_dalek::SigningKey) -> String {
        let profile = Profile {
            user_id: UID.into(),
            handle: "alice".into(),
            auth_public_key: URL_SAFE_NO_PAD.encode(sk.verifying_key().to_bytes()),
            sharing_public_key: "old".into(),
            key_version: 1,
            ..Default::default()
        };
        put_json(store, &key_profile(UID), &profile).await;
        store
            .put_object(&key_device(UID, DID), b"{}", "application/json")
            .await
            .unwrap();
        token::generate(TEST_SECRET, UID, DID, KeyVersion::ONE)
    }

    /// Build a rotation body, signing the canonical signed-fields with `sk`.
    fn rotation_body(
        request_id: &str,
        key_version: u32,
        sk: &ed25519_dalek::SigningKey,
        auth: &str,
        sharing: &str,
        salt: &str,
        kdf: &serde_json::Value,
    ) -> String {
        use ed25519_dalek::Signer;
        let signed = serde_json::json!({
            "request_id": request_id, "key_version": key_version,
            "auth_public_key": auth, "sharing_public_key": sharing,
            "salt": salt, "kdf": kdf,
        });
        let canonical = crate::authproof::canonicalize(signed.to_string().as_bytes()).unwrap();
        let sig = sk.sign(&canonical);
        serde_json::json!({
            "request_id": request_id, "key_version": key_version,
            "auth_public_key": auth, "sharing_public_key": sharing,
            "salt": salt, "kdf": kdf,
            "continuity_signature": URL_SAFE_NO_PAD.encode(sig.to_bytes()),
        })
        .to_string()
    }

    async fn post_rotate<'a>(
        client: &'a Client,
        token: &str,
        body: String,
    ) -> rocket::local::asynchronous::LocalResponse<'a> {
        client
            .post("/v1/rotate-keys")
            .header(ContentType::JSON)
            .header(bearer(token))
            .body(body)
            .dispatch()
            .await
    }

    async fn stored_profile(client: &Client) -> Profile {
        let bytes = client
            .rocket()
            .state::<SharedStore>()
            .unwrap()
            .get_object(&key_profile(UID))
            .await
            .unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn rotate_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let resp = client
            .post("/v1/rotate-keys")
            .header(ContentType::JSON)
            .body("{}")
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn rotate_happy_path_advances_kv_and_mints_token() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let store = MemStore::new();
        let token = seed_for_rotation(&store, &sk).await;
        let client = client_with(store).await;
        let (auth, sharing, salt, kdf) = new_keys();

        let body = rotation_body(REQ_ID, 2, &sk, &auth, &sharing, &salt, &kdf);
        let resp = post_rotate(&client, &token, body).await;
        assert_eq!(resp.status(), Status::Ok);
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(rb["key_version"], 2);
        let new_token = rb["token"].as_str().unwrap().to_string();

        // Profile advanced to kv=2 with the new key.
        let p = stored_profile(&client).await;
        assert_eq!(p.key_version, 2);
        assert_eq!(p.auth_public_key, auth);

        // The freshly minted kv=2 token authenticates (the kv cache was invalidated).
        let uri = format!("/v1/store/list?prefix=inbox/{UID}/live/");
        let r2 = client
            .get(uri.as_str())
            .header(bearer(&new_token))
            .dispatch()
            .await;
        assert_eq!(r2.status(), Status::Ok);
    }

    #[tokio::test]
    async fn rotate_is_idempotent_on_request_id() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let store = MemStore::new();
        let token = seed_for_rotation(&store, &sk).await;
        let client = client_with(store).await;
        let (auth, sharing, salt, kdf) = new_keys();
        let body = rotation_body(REQ_ID, 2, &sk, &auth, &sharing, &salt, &kdf);

        let r1 = post_rotate(&client, &token, body.clone()).await;
        assert_eq!(r1.status(), Status::Ok);
        let token1: serde_json::Value =
            serde_json::from_str(&r1.into_string().await.unwrap()).unwrap();

        // Replaying the same request_id returns the recorded outcome verbatim...
        let r2 = post_rotate(&client, &token, body).await;
        assert_eq!(r2.status(), Status::Ok);
        let token2: serde_json::Value =
            serde_json::from_str(&r2.into_string().await.unwrap()).unwrap();
        assert_eq!(token1["token"], token2["token"]);
        // ...and the kv did NOT advance a second time.
        assert_eq!(stored_profile(&client).await.key_version, 2);
    }

    #[tokio::test]
    async fn rotate_wrong_target_kv_is_409() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let store = MemStore::new();
        let token = seed_for_rotation(&store, &sk).await; // current kv=1
        let client = client_with(store).await;
        let (auth, sharing, salt, kdf) = new_keys();
        // Target kv=5 ≠ current+1 (=2) → precondition fails before continuity.
        let body = rotation_body(REQ_ID, 5, &sk, &auth, &sharing, &salt, &kdf);
        let resp = post_rotate(&client, &token, body).await;
        assert_eq!(resp.status(), Status::Conflict);
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(rb["error"], "key_version_stale");
        assert_eq!(rb["current"], 1);
    }

    #[tokio::test]
    async fn rotate_bad_continuity_is_403() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let store = MemStore::new();
        let token = seed_for_rotation(&store, &sk).await;
        let client = client_with(store).await;
        let (auth, sharing, salt, kdf) = new_keys();
        // Sign with a different key than the account's auth_public_key.
        let wrong = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let body = rotation_body(REQ_ID, 2, &wrong, &auth, &sharing, &salt, &kdf);
        let resp = post_rotate(&client, &token, body).await;
        assert_eq!(resp.status(), Status::Forbidden);
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(rb["error"], "bad_continuity");
    }

    #[tokio::test]
    async fn rotate_contention_is_409_with_current_minus_one() {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let store = MemStore::new();
        let token = seed_for_rotation(&store, &sk).await;
        let client = client_with(store).await;
        // Hold the rotation lock for UID externally → the handler times out.
        let mu = client.rocket().state::<RotationMutex>().unwrap().0.clone();
        let _held = mu.acquire(UID, StdDuration::from_secs(5)).await.unwrap();

        let (auth, sharing, salt, kdf) = new_keys();
        let body = rotation_body(REQ_ID, 2, &sk, &auth, &sharing, &salt, &kdf);
        let resp = post_rotate(&client, &token, body).await;
        assert_eq!(resp.status(), Status::Conflict);
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(rb["current"], -1);
    }

    #[tokio::test]
    async fn rotate_stale_token_still_reaches_handler() {
        // authNoKV: a superseded token must NOT be 401'd at the guard (as it would
        // be on a normal endpoint) — it reaches the handler and hits the kv
        // precondition (409), proving the guard's kv check was skipped.
        let store = MemStore::new();
        let _ = seed_account(&store, 2).await; // profile kv=2 + device
        let stale = token::generate(TEST_SECRET, UID, DID, KeyVersion::ONE); // kv=1
        let client = client_with(store).await;
        let (auth, sharing, salt, kdf) = new_keys();
        let sk = ed25519_dalek::SigningKey::from_bytes(&[3u8; 32]);
        // Wrong target kv (99) → 409 at the precondition, before continuity.
        let body = rotation_body(REQ_ID, 99, &sk, &auth, &sharing, &salt, &kdf);
        let resp = post_rotate(&client, &stale, body).await;
        assert_eq!(resp.status(), Status::Conflict); // NOT 401
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(rb["current"], 2);
    }

    // --- delete-profile (authed; wipe + handle tombstone under the claim lock) ---

    #[tokio::test]
    async fn delete_profile_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let resp = client.delete("/v1/profile").dispatch().await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn delete_profile_wipes_account_and_tombstones_handle() {
        let client = client_with(MemStore::new()).await;
        let resp = register(&client, register_body("alice")).await;
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        let user_id = rb["user_id"].as_str().unwrap().to_string();
        let token = rb["token"].as_str().unwrap().to_string();

        let resp = client
            .delete("/v1/profile")
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);

        // The handle is now a cooldown tombstone (resolve → 410 released).
        let r = client.get("/v1/resolve/alice").dispatch().await;
        assert_eq!(r.status(), Status::Gone);
        let b: serde_json::Value = serde_json::from_str(&r.into_string().await.unwrap()).unwrap();
        assert_eq!(b["error"], "released");

        // The device was wiped *and* its cache entry evicted → the token no longer
        // authenticates (403 device_revoked, not a stale-cache 200).
        let uri = format!("/v1/store/list?prefix=inbox/{user_id}/live/");
        let r = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(r.status(), Status::Forbidden);
        let b: serde_json::Value = serde_json::from_str(&r.into_string().await.unwrap()).unwrap();
        assert_eq!(b["error"], "device_revoked");
    }

    #[tokio::test]
    async fn delete_profile_handle_contention_is_503() {
        let client = client_with(MemStore::new()).await;
        let token = register_token(&client, "alice").await;
        // Hold the (shared) handle lock for "alice"; the tombstone write then times
        // out. Account contents are wiped first, so a retry installs the tombstone.
        let mu = client
            .rocket()
            .state::<HandleClaimMutex>()
            .unwrap()
            .0
            .clone();
        let _held = mu
            .acquire("alice", StdDuration::from_secs(5))
            .await
            .unwrap();

        let resp = client
            .delete("/v1/profile")
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::ServiceUnavailable);
        let b: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(b["error"], "registration_unavailable");
    }

    // --- device delete / revoke (authed; cache eviction) ---

    /// A second device id to revoke (the handler doesn't validate its format).
    const DID2: &str = "01BX5ZZKBKACTAV9WEVGEMMVR0";

    async fn post_revoke<'a>(
        client: &'a Client,
        token: &str,
        body: String,
    ) -> rocket::local::asynchronous::LocalResponse<'a> {
        client
            .post("/v1/devices/revoke")
            .header(ContentType::JSON)
            .header(bearer(token))
            .body(body)
            .dispatch()
            .await
    }

    #[tokio::test]
    async fn delete_device_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let resp = client.delete("/v1/devices").dispatch().await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn delete_device_self_deletes_and_evicts_cache() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;

        let resp = client
            .delete("/v1/devices")
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);

        // The calling device is gone and its cache entry evicted → the token no
        // longer authenticates (403 device_revoked, not a stale-cache 200).
        let uri = format!("/v1/store/list?prefix=inbox/{UID}/live/");
        let r = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(r.status(), Status::Forbidden);
        let b: serde_json::Value = serde_json::from_str(&r.into_string().await.unwrap()).unwrap();
        assert_eq!(b["error"], "device_revoked");
    }

    #[tokio::test]
    async fn revoke_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let resp = client
            .post("/v1/devices/revoke")
            .header(ContentType::JSON)
            .body("{}")
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn revoke_deletes_target_device_with_valid_proof() {
        let (sk, pk) = proof_keypair();
        let store = MemStore::new();
        seed_profile_with_pubkey(&store, &pk, 1).await;
        // Calling device (for the token) + the target device to revoke.
        store
            .put_object(&key_device(UID, DID), b"{}", "application/json")
            .await
            .unwrap();
        store
            .put_object(&key_device(UID, DID2), b"{}", "application/json")
            .await
            .unwrap();
        let token = token::generate(TEST_SECRET, UID, DID, KeyVersion::ONE);
        let client = client_with(store).await;

        let proof = signed_proof(&sk, UID, DID, &now_rfc3339(), 1);
        let body = serde_json::json!({ "device_id": DID2, "auth_proof": proof }).to_string();
        let resp = post_revoke(&client, &token, body).await;
        assert_eq!(resp.status(), Status::Ok);

        // The target device file is gone.
        let head = client
            .rocket()
            .state::<SharedStore>()
            .unwrap()
            .head_object(&key_device(UID, DID2))
            .await;
        assert!(head.is_err());
    }

    #[tokio::test]
    async fn revoke_bad_proof_is_403() {
        let (_, pk) = proof_keypair();
        let store = MemStore::new();
        seed_profile_with_pubkey(&store, &pk, 1).await;
        store
            .put_object(&key_device(UID, DID), b"{}", "application/json")
            .await
            .unwrap();
        let token = token::generate(TEST_SECRET, UID, DID, KeyVersion::ONE);
        let client = client_with(store).await;
        // Proof signed by a different key than the account's auth_public_key.
        let wrong = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let proof = signed_proof(&wrong, UID, DID, &now_rfc3339(), 1);
        let body = serde_json::json!({ "device_id": DID, "auth_proof": proof }).to_string();
        let resp = post_revoke(&client, &token, body).await;
        assert_eq!(resp.status(), Status::Forbidden);
    }

    #[tokio::test]
    async fn revoke_stale_proof_kv_is_401() {
        let (sk, pk) = proof_keypair();
        let store = MemStore::new();
        seed_profile_with_pubkey(&store, &pk, 2).await; // account kv=2
        store
            .put_object(&key_device(UID, DID), b"{}", "application/json")
            .await
            .unwrap();
        let token = token::generate(TEST_SECRET, UID, DID, KeyVersion::new(2).unwrap());
        let client = client_with(store).await;
        // Proof claims kv=1 against a kv=2 account.
        let proof = signed_proof(&sk, UID, DID, &now_rfc3339(), 1);
        let body = serde_json::json!({ "device_id": DID, "auth_proof": proof }).to_string();
        let resp = post_revoke(&client, &token, body).await;
        assert_eq!(resp.status(), Status::Unauthorized);
        let b: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(b["error"], "key_version_stale");
        assert_eq!(b["current"], 2);
    }

    // --- events SSE ---
    // Only the pre-stream auth path is unit-testable: a successful stream is
    // infinite and would hang the local client. Fan-out + last_active are covered
    // by events.rs unit tests; the live stream is covered by the e2e suite.

    #[tokio::test]
    async fn events_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let resp = client.get("/v1/events").dispatch().await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    // --- store/object (authed single-key read) ---

    #[tokio::test]
    async fn store_object_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let uri = format!("/v1/store/object?key=inbox/{UID}/live/m1");
        let resp = client.get(uri.as_str()).dispatch().await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn store_object_returns_owned_bytes() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        store
            .put_object(
                &format!("inbox/{UID}/live/m1"),
                b"ciphertext",
                "application/octet-stream",
            )
            .await
            .unwrap();

        let client = client_with(store).await;
        let uri = format!("/v1/store/object?key=inbox/{UID}/live/m1");
        let resp = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
        assert_eq!(resp.content_type(), Some(ContentType::Binary));
        // Non-media: no caching directive.
        assert_eq!(resp.headers().get_one("Cache-Control"), None);
        assert_eq!(resp.into_bytes().await.unwrap(), b"ciphertext".to_vec());
    }

    #[tokio::test]
    async fn store_object_media_is_readable_by_any_user_and_cacheable() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await; // authed as UID
                                                   // A media blob under a *different* user — capability-protected, any
                                                   // authenticated caller may GET it.
        store
            .put_object(
                "media/01BX5ZZKBKACTAV9WEVGEMMVRZ/01MEDIA",
                b"blob",
                "application/octet-stream",
            )
            .await
            .unwrap();

        let client = client_with(store).await;
        let resp = client
            .get("/v1/store/object?key=media/01BX5ZZKBKACTAV9WEVGEMMVRZ/01MEDIA")
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
        assert_eq!(
            resp.headers().get_one("Cache-Control"),
            Some("public, immutable, max-age=31536000")
        );
        assert_eq!(resp.into_bytes().await.unwrap(), b"blob".to_vec());
    }

    #[tokio::test]
    async fn store_object_other_users_data_is_403() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let resp = client
            .get("/v1/store/object?key=inbox/01BX5ZZKBKACTAV9WEVGEMMVRZ/live/m")
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Forbidden);
    }

    #[tokio::test]
    async fn store_object_missing_is_404() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let uri = format!("/v1/store/object?key=inbox/{UID}/live/nope");
        let resp = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::NotFound);
    }

    // --- register (public) ---

    fn register_body(handle: &str) -> String {
        let salt = URL_SAFE_NO_PAD.encode([0u8; 16]); // 16-byte salt, base64url
        serde_json::json!({
            "handle": handle,
            "device_label": "laptop",
            "auth_public_key": "QXV0aA",
            "sharing_public_key": "U2hhcmU",
            "salt": salt,
            "kdf": { "type": "argon2id", "m": 65536, "t": 3, "p": 1 },
        })
        .to_string()
    }

    async fn register(
        client: &Client,
        body: String,
    ) -> rocket::local::asynchronous::LocalResponse<'_> {
        client
            .post("/v1/register")
            .header(ContentType::JSON)
            .body(body)
            .dispatch()
            .await
    }

    #[tokio::test]
    async fn register_happy_path_then_token_works() {
        let client = client_with(MemStore::new()).await;
        let resp = register(&client, register_body("alice")).await;
        assert_eq!(resp.status(), Status::Ok);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        let user_id = body["user_id"].as_str().unwrap().to_string();
        let token = body["token"].as_str().unwrap().to_string();
        assert_eq!(body["handle"], "alice");
        assert_eq!(user_id.len(), 26); // ULID

        // The handle projection is now resolvable...
        let resp = client.get("/v1/resolve/alice").dispatch().await;
        assert_eq!(resp.status(), Status::Ok);

        // ...and the returned token authenticates (proves profile + device were written).
        let uri = format!("/v1/store/list?prefix=inbox/{user_id}/live/");
        let resp = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
    }

    #[tokio::test]
    async fn register_rejects_invalid_handle() {
        let client = client_with(MemStore::new()).await;
        let resp = register(&client, register_body("Ab")).await; // uppercase + too short
        assert_eq!(resp.status(), Status::BadRequest);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(body["error"], "handle_invalid");
    }

    #[tokio::test]
    async fn register_rejects_reserved_handle() {
        let client = client_with(MemStore::new()).await;
        let resp = register(&client, register_body("admin")).await;
        assert_eq!(resp.status(), Status::BadRequest);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(body["error"], "handle_reserved");
    }

    #[tokio::test]
    async fn register_taken_handle_is_409() {
        let client = client_with(MemStore::new()).await;
        assert_eq!(
            register(&client, register_body("bob")).await.status(),
            Status::Ok
        );
        let resp = register(&client, register_body("bob")).await;
        assert_eq!(resp.status(), Status::Conflict);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(body["error"], "handle_taken");
    }

    #[tokio::test]
    async fn register_handle_in_cooldown_is_409() {
        let store = MemStore::new();
        let tombstone = PublicHandleData {
            released_at: "2099-01-01T00:00:00Z".into(),
            ..Default::default()
        };
        put_json(&store, &key_handle("eve"), &tombstone).await;
        let client = client_with(store).await;
        let resp = register(&client, register_body("eve")).await;
        assert_eq!(resp.status(), Status::Conflict);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(body["error"], "handle_in_cooldown");
        assert_eq!(body["available_at"], "2099-01-31T00:00:00Z");
    }

    #[tokio::test]
    async fn register_handle_claim_contention_is_503() {
        let client = client_with(MemStore::new()).await;
        // Hold the claim lock for "frank" externally; the handler's 500ms acquire
        // then times out → registration_unavailable.
        let mu = client
            .rocket()
            .state::<HandleClaimMutex>()
            .unwrap()
            .0
            .clone();
        let _held = mu
            .acquire("frank", StdDuration::from_secs(5))
            .await
            .unwrap();

        let resp = register(&client, register_body("frank")).await;
        assert_eq!(resp.status(), Status::ServiceUnavailable);
        let body: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(body["error"], "registration_unavailable");
    }

    #[tokio::test]
    async fn register_rejects_weak_kdf() {
        let client = client_with(MemStore::new()).await;
        let salt = URL_SAFE_NO_PAD.encode([0u8; 16]);
        let body = serde_json::json!({
            "handle": "carol", "device_label": "l",
            "auth_public_key": "a", "sharing_public_key": "s",
            "salt": salt,
            "kdf": { "type": "argon2id", "m": 1024, "t": 3, "p": 1 }, // m below the 64 MiB floor
        })
        .to_string();
        let resp = register(&client, body).await;
        assert_eq!(resp.status(), Status::BadRequest);
    }

    #[tokio::test]
    async fn register_missing_fields_is_400() {
        let client = client_with(MemStore::new()).await;
        let resp = register(&client, serde_json::json!({ "handle": "dave" }).to_string()).await;
        assert_eq!(resp.status(), Status::BadRequest);
    }

    // --- add-device / returning device (public; the signed proof is the credential) ---

    fn proof_keypair() -> (ed25519_dalek::SigningKey, String) {
        let sk = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]);
        let pubkey_b64 = URL_SAFE_NO_PAD.encode(sk.verifying_key().to_bytes());
        (sk, pubkey_b64)
    }

    fn signed_proof(
        sk: &ed25519_dalek::SigningKey,
        user_id: &str,
        device_id: &str,
        timestamp: &str,
        kv: u32,
    ) -> serde_json::Value {
        use ed25519_dalek::Signer;
        let payload = serde_json::json!({
            "user_id": user_id, "device_id": device_id,
            "timestamp": timestamp, "key_version": kv,
        });
        // Sign over the JCS-canonical payload — exactly what the server re-derives.
        let canonical = crate::authproof::canonicalize(payload.to_string().as_bytes()).unwrap();
        let sig = sk.sign(&canonical);
        serde_json::json!({
            "payload": payload,
            "signature": URL_SAFE_NO_PAD.encode(sig.to_bytes()),
        })
    }

    async fn seed_profile_with_pubkey(store: &MemStore, pubkey_b64: &str, kv: u32) {
        let profile = Profile {
            user_id: UID.into(),
            auth_public_key: pubkey_b64.into(),
            key_version: kv,
            ..Default::default()
        };
        put_json(store, &key_profile(UID), &profile).await;
    }

    fn now_rfc3339() -> String {
        Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
    }

    async fn post_add_device(
        client: &Client,
        body: String,
    ) -> rocket::local::asynchronous::LocalResponse<'_> {
        client
            .post("/v1/devices")
            .header(ContentType::JSON)
            .body(body)
            .dispatch()
            .await
    }

    #[tokio::test]
    async fn add_device_happy_then_token_works() {
        let (sk, pk) = proof_keypair();
        let store = MemStore::new();
        seed_profile_with_pubkey(&store, &pk, 1).await;
        let client = client_with(store).await;

        let proof = signed_proof(&sk, UID, DID, &now_rfc3339(), 1);
        let body =
            serde_json::json!({ "user_id": UID, "device_label": "phone", "auth_proof": proof })
                .to_string();
        let resp = post_add_device(&client, body).await;
        assert_eq!(resp.status(), Status::Ok);
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(rb["device_id"], DID);
        let token = rb["token"].as_str().unwrap().to_string();

        // The freshly issued token authenticates (the device file was written).
        let uri = format!("/v1/store/list?prefix=inbox/{UID}/live/");
        let resp = client
            .get(uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
    }

    #[tokio::test]
    async fn add_device_unknown_account_is_404() {
        let (sk, _) = proof_keypair();
        let client = client_with(MemStore::new()).await; // no profile seeded
        let proof = signed_proof(&sk, UID, DID, &now_rfc3339(), 1);
        let body = serde_json::json!({ "user_id": UID, "device_label": "x", "auth_proof": proof })
            .to_string();
        assert_eq!(
            post_add_device(&client, body).await.status(),
            Status::NotFound
        );
    }

    #[tokio::test]
    async fn add_device_bad_signature_is_403() {
        let (_, pk) = proof_keypair();
        // Sign with a different key than the account's auth_public_key.
        let wrong = ed25519_dalek::SigningKey::from_bytes(&[9u8; 32]);
        let store = MemStore::new();
        seed_profile_with_pubkey(&store, &pk, 1).await;
        let client = client_with(store).await;
        let proof = signed_proof(&wrong, UID, DID, &now_rfc3339(), 1);
        let body = serde_json::json!({ "user_id": UID, "device_label": "x", "auth_proof": proof })
            .to_string();
        assert_eq!(
            post_add_device(&client, body).await.status(),
            Status::Forbidden
        );
    }

    #[tokio::test]
    async fn add_device_expired_proof_is_403() {
        let (sk, pk) = proof_keypair();
        let store = MemStore::new();
        seed_profile_with_pubkey(&store, &pk, 1).await;
        let client = client_with(store).await;
        let stale = (Utc::now() - Duration::days(1)).to_rfc3339_opts(SecondsFormat::Secs, true);
        let proof = signed_proof(&sk, UID, DID, &stale, 1);
        let body = serde_json::json!({ "user_id": UID, "device_label": "x", "auth_proof": proof })
            .to_string();
        assert_eq!(
            post_add_device(&client, body).await.status(),
            Status::Forbidden
        );
    }

    #[tokio::test]
    async fn add_device_stale_key_version_is_401() {
        let (sk, pk) = proof_keypair();
        let store = MemStore::new();
        seed_profile_with_pubkey(&store, &pk, 2).await; // account at kv 2
        let client = client_with(store).await;
        let proof = signed_proof(&sk, UID, DID, &now_rfc3339(), 1); // proof claims kv 1
        let body = serde_json::json!({ "user_id": UID, "device_label": "x", "auth_proof": proof })
            .to_string();
        let resp = post_add_device(&client, body).await;
        assert_eq!(resp.status(), Status::Unauthorized);
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(rb["error"], "key_version_stale");
        assert_eq!(rb["current"], 2);
    }

    // --- store/compact (authed; first real use of the cbor module) ---

    #[tokio::test]
    async fn compact_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let body = serde_json::json!({ "prefix": format!("inbox/{UID}/live/"), "up_to": "m9" })
            .to_string();
        let resp = client
            .post("/v1/store/compact")
            .header(ContentType::JSON)
            .body(body)
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn compact_other_users_prefix_is_403() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let body = serde_json::json!({
            "prefix": "inbox/01BX5ZZKBKACTAV9WEVGEMMVRZ/live/", "up_to": "m9"
        })
        .to_string();
        let resp = client
            .post("/v1/store/compact")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(body)
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Forbidden);
    }

    #[tokio::test]
    async fn compact_nothing_returns_zero() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let body = serde_json::json!({ "prefix": format!("inbox/{UID}/live/"), "up_to": "m9" })
            .to_string();
        let resp = client
            .post("/v1/store/compact")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(body)
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(rb["archived"], 0);
        assert_eq!(rb["archive_key"], "");
    }

    #[tokio::test]
    async fn compact_archives_live_objects_and_deletes_them() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let live = format!("inbox/{UID}/live/");
        store
            .put_object(
                &format!("{live}m1"),
                br#"{"msg_id":"m1","v":1}"#,
                "application/json",
            )
            .await
            .unwrap();
        store
            .put_object(
                &format!("{live}m2"),
                br#"{"msg_id":"m2","v":1}"#,
                "application/json",
            )
            .await
            .unwrap();
        let client = client_with(store).await;

        let body = serde_json::json!({ "prefix": live.clone(), "up_to": "m9" }).to_string();
        let resp = client
            .post("/v1/store/compact")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(body)
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(rb["archived"], 2);
        let archive_key = rb["archive_key"].as_str().unwrap().to_string();
        assert!(archive_key.starts_with(&format!("inbox/{UID}/archive/")));

        // Live objects are gone.
        let list_uri = format!("/v1/store/list?prefix={live}");
        let resp = client
            .get(list_uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        let lb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(lb["keys"], serde_json::json!([]));

        // The archive holds both messages — fetch it and decode the CBOR.
        let obj_uri = format!("/v1/store/object?key={archive_key}");
        let resp = client
            .get(obj_uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
        let entries = crate::cbor::decode_archive(&resp.into_bytes().await.unwrap()).unwrap();
        assert_eq!(entries.len(), 2);
    }

    // --- PUT /v1/profile (authed update + re-project) ---

    async fn register_token(client: &Client, handle: &str) -> String {
        let resp = register(client, register_body(handle)).await;
        let rb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        rb["token"].as_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn update_profile_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let resp = client
            .put("/v1/profile")
            .header(ContentType::JSON)
            .body(serde_json::json!({ "display_name": "x" }).to_string())
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn update_profile_no_fields_is_400() {
        let client = client_with(MemStore::new()).await;
        let token = register_token(&client, "bob").await;
        let resp = client
            .put("/v1/profile")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body("{}")
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::BadRequest);
    }

    #[tokio::test]
    async fn update_profile_sets_display_name_and_reprojects() {
        let client = client_with(MemStore::new()).await;
        let token = register_token(&client, "alice").await;

        let resp = client
            .put("/v1/profile")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(serde_json::json!({ "display_name": "Alice A." }).to_string())
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);

        // resolve reflects the new display_name in the re-projected handle file.
        let resp = client.get("/v1/resolve/alice").dispatch().await;
        let pb: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(pb["display_name"], "Alice A.");
    }

    // --- store/usage + presign + delete (the MediaQuota cluster) ---

    #[tokio::test]
    async fn store_usage_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let resp = client.get("/v1/store/usage").dispatch().await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn store_usage_reports_quota_constants_and_zero_usage() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let resp = client
            .get("/v1/store/usage")
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
        let b: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(b["used_bytes"], 0);
        assert_eq!(b["blob_count"], 0);
        assert_eq!(b["quota_bytes"], 1u64 << 30);
        assert_eq!(b["quota_blob_cap"], 1000);
    }

    #[tokio::test]
    async fn presign_requires_a_token() {
        let client = client_with(MemStore::new()).await;
        let resp = client
            .post("/v1/store/presign")
            .header(ContentType::JSON)
            .body(serde_json::json!({ "key": format!("media/{UID}/01A"), "bytes": 10 }).to_string())
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Unauthorized);
    }

    #[tokio::test]
    async fn presign_missing_fields_is_400() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        // bytes <= 0 is rejected.
        let resp = client
            .post("/v1/store/presign")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(serde_json::json!({ "key": format!("media/{UID}/01A"), "bytes": 0 }).to_string())
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::BadRequest);
    }

    #[tokio::test]
    async fn presign_other_users_key_is_403() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let resp = client
            .post("/v1/store/presign")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(
                serde_json::json!({ "key": "media/01BX5ZZKBKACTAV9WEVGEMMVRZ/01A", "bytes": 10 })
                    .to_string(),
            )
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Forbidden);
    }

    #[tokio::test]
    async fn presign_object_name_unsafe_key_is_400() {
        // A key under the caller's own prefix (authorize passes) but with a
        // doubled slash — what a raw base64 session_id could produce — is
        // rejected at the API as a clear 400 rather than failing opaquely at
        // the eventual S3 PUT (I10).
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let resp = client
            .post("/v1/store/presign")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(
                serde_json::json!({ "key": format!("keys/{UID}/live//abc"), "bytes": 10 })
                    .to_string(),
            )
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::BadRequest);
    }

    #[tokio::test]
    async fn presign_media_over_blob_cap_is_413_too_large() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let resp = client
            .post("/v1/store/presign")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(
                serde_json::json!({
                    "key": format!("media/{UID}/01A"),
                    "bytes": MAX_MEDIA_BYTES + 1,
                })
                .to_string(),
            )
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::PayloadTooLarge);
        let b: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(b["error"], "too_large");
    }

    #[tokio::test]
    async fn presign_media_happy_path_returns_url_and_reserves() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let key = format!("media/{UID}/01A");
        let resp = client
            .post("/v1/store/presign")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(serde_json::json!({ "key": key, "bytes": 1234 }).to_string())
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
        let b: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(b["presigned_url"], format!("http://fake-presign/{key}"));

        // The reservation is reflected in usage (optimistic increment, no S3 write).
        let resp = client
            .get("/v1/store/usage")
            .header(bearer(&token))
            .dispatch()
            .await;
        let u: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(u["used_bytes"], 1234);
        assert_eq!(u["blob_count"], 1);
    }

    #[tokio::test]
    async fn presign_non_media_skips_quota() {
        // A keys/ backup presign isn't size-checked or quota-reserved.
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        let resp = client
            .post("/v1/store/presign")
            .header(ContentType::JSON)
            .header(bearer(&token))
            .body(
                serde_json::json!({
                    "key": format!("keys/{UID}/live/01S"),
                    "bytes": MAX_MEDIA_BYTES + 1, // would exceed the media cap, but not media
                })
                .to_string(),
            )
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);
    }

    #[tokio::test]
    async fn delete_object_owner_only_and_invalidates_quota() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        // A media blob exists in S3; usage probes it.
        store
            .put_object(
                &format!("media/{UID}/01A"),
                &[0u8; 500],
                "application/octet-stream",
            )
            .await
            .unwrap();
        let client = client_with(store).await;

        // Usage reflects the 500-byte blob (first probe populates the cache).
        let resp = client
            .get("/v1/store/usage")
            .header(bearer(&token))
            .dispatch()
            .await;
        let u: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(u["used_bytes"], 500);

        // Delete it (owner-only); idempotent 200.
        let del_uri = format!("/v1/store/object?key=media/{UID}/01A");
        let resp = client
            .delete(del_uri.as_str())
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Ok);

        // Quota was invalidated → the next usage re-probes and sees the blob gone.
        let resp = client
            .get("/v1/store/usage")
            .header(bearer(&token))
            .dispatch()
            .await;
        let u: serde_json::Value =
            serde_json::from_str(&resp.into_string().await.unwrap()).unwrap();
        assert_eq!(u["used_bytes"], 0);
        assert_eq!(u["blob_count"], 0);
    }

    #[tokio::test]
    async fn delete_object_other_users_key_is_403() {
        let store = MemStore::new();
        let token = seed_account(&store, 1).await;
        let client = client_with(store).await;
        // Media is publicly *readable* but owner-only for writes/deletes.
        let resp = client
            .delete("/v1/store/object?key=media/01BX5ZZKBKACTAV9WEVGEMMVRZ/01A")
            .header(bearer(&token))
            .dispatch()
            .await;
        assert_eq!(resp.status(), Status::Forbidden);
    }
}
