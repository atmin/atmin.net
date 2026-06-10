//! HTTP routes (Rocket). Mirrors `server/routes.go` (`newMux`). Built up through
//! phase 3; `build` mounts whatever handlers exist so far. Production wiring (an
//! S3-backed store, `#[launch]` main) lands in phase 4.

use crate::config::ServerConfig;
use crate::error::ApiError;
use crate::guard::AuthedUser;
use crate::model::{Handle, KeyVersion};
use crate::paths::{authorize_key, authorize_prefix, key_device, key_handle, key_profile};
use crate::profile::{valid_kdf_params, KdfParams, Profile, PublicHandleData};
use crate::reserved;
use crate::store::{SharedStore, StoreError};
use crate::token;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rocket::http::ContentType;
use rocket::response::Responder;
use rocket::serde::json::Json;
use rocket::serde::{Deserialize, Serialize};
use rocket::{get, post, routes, Build, Request, Response, Rocket, State};
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
        routes![healthz, resolve, register, store_list, store_object],
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
}
