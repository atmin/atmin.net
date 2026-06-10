//! HTTP routes (Rocket). Mirrors `server/routes.go` (`newMux`). Built up through
//! phase 3; `build` mounts whatever handlers exist so far. Production wiring (an
//! S3-backed store, `#[launch]` main) lands in phase 4.

use crate::authproof::{verify_proof, AuthProof};
use crate::cbor;
use crate::config::ServerConfig;
use crate::error::ApiError;
use crate::guard::AuthedUser;
use crate::model::{DeviceId, Handle, KeyVersion, UserId};
use crate::paths::{authorize_key, authorize_prefix, key_device, key_handle, key_profile};
use crate::profile::{valid_kdf_params, KdfParams, Profile, PublicHandleData};
use crate::reserved;
use crate::store::{SharedStore, StoreError};
use crate::token;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use ciborium::value::Value;
use rocket::http::ContentType;
use rocket::response::Responder;
use rocket::serde::json::Json;
use rocket::serde::{Deserialize, Serialize};
use rocket::{get, post, put, routes, Build, Request, Response, Rocket, State};
use std::io::Cursor;
use ulid::Ulid;

/// Post-deletion handle reservation window (ADR-0013).
const HANDLE_COOLDOWN_DAYS: i64 = 30;

/// Default page size for `GET /v1/store/list` (mirrors Go's `limit := 50`).
const STORE_LIST_LIMIT: usize = 50;

/// Build the Rocket app over a given store + config. Tests pass a `MemStore`;
/// production will pass an S3-backed store.
pub fn build(store: SharedStore, config: ServerConfig) -> Rocket<Build> {
    rocket::build().manage(store).manage(config).mount(
        "/",
        routes![
            healthz,
            resolve,
            register,
            add_device,
            store_list,
            store_object,
            store_compact,
            update_profile
        ],
    )
}

#[get("/healthz")]
fn healthz() -> &'static str {
    "ok"
}

/// `GET /v1/resolve/{handle}` — public handle lookup. Mirrors `handleResolve`.
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

    // TODO(phase 3): legacy backfill from profile.json for pre-v2 projections
    // (missing sharing_public_key / salt / kdf). Skipped — fresh-world projections
    // are always complete; only legacy data triggered it.

    Ok(Json(h))
}

#[derive(Serialize)]
struct StoreListResponse {
    keys: Vec<String>,
    /// Empty string when there are no more pages (mirrors Go's `""` convention).
    next_cursor: String,
}

/// `GET /v1/store/list` — authed listing of keys under a prefix the caller owns.
/// Mirrors `handleStoreList`. First endpoint behind the `AuthedUser` guard.
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
/// Mirrors `handleStoreObject`.
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
/// write the handle projection + profile + device. Public. Mirrors `handleRegister`.
#[post("/v1/register", data = "<body>")]
async fn register(
    body: &str,
    store: &State<SharedStore>,
    config: &State<ServerConfig>,
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

    // TODO(phase 5): wrap the GET-then-PUT below in the per-handle claim mutex
    // (ADR-0013). Without it, two concurrent registrations of the SAME handle can
    // both observe 404 and both PUT (last-writer-wins). Deferred with the other
    // in-process concurrency primitives (keyed mutexes, SSE hub); `registration_
    // unavailable` (the mutex-timeout outcome) therefore can't occur yet.
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
/// (the proof *is* the credential). Mirrors `handleAddDevice`.
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
    // bad signature, or stale timestamp is all a 403 (mirrors errAuthProofInvalid).
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

    // device_id comes from the signed payload; validate it's a ULID (the port's
    // ULID-strict tightening, ADR-0018 Findings).
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
/// same-day archives. Mirrors `handleStoreCompact`.
///
/// Note: live objects are JSON; decoded here to `ciborium::Value`, so JSON
/// integers stay CBOR integers (Go's path goes via `float64`, producing CBOR
/// doubles — the phase-1 finding). Benign: clients already tolerate both, since
/// live objects are JSON ints and Go archives are doubles; no legacy data exists.
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
/// Mirrors `putHandleProjection`'s field set.
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
/// the public fields to the handle file. Mirrors `handleProfile`. A field absent
/// or `null` means "leave unchanged"; present (even `""`) means "set". At least
/// one field is required.
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

    // Re-project public fields. Best-effort, like Go — a projection failure does
    // not fail the update.
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
}
