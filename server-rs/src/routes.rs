//! HTTP routes (Rocket). Mirrors `server/routes.go` (`newMux`). Built up through
//! phase 3; `build` mounts whatever handlers exist so far. Production wiring (an
//! S3-backed store, `#[launch]` main) lands in phase 4.

use crate::config::ServerConfig;
use crate::error::ApiError;
use crate::guard::AuthedUser;
use crate::paths::{authorize_prefix, key_handle};
use crate::profile::PublicHandleData;
use crate::store::SharedStore;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rocket::serde::json::Json;
use rocket::serde::Serialize;
use rocket::{get, routes, Build, Rocket, State};

/// Post-deletion handle reservation window (ADR-0013).
const HANDLE_COOLDOWN_DAYS: i64 = 30;

/// Default page size for `GET /v1/store/list` (mirrors Go's `limit := 50`).
const STORE_LIST_LIMIT: usize = 50;

/// Build the Rocket app over a given store + config. Tests pass a `MemStore`;
/// production will pass an S3-backed store.
pub fn build(store: SharedStore, config: ServerConfig) -> Rocket<Build> {
    rocket::build()
        .manage(store)
        .manage(config)
        .mount("/", routes![healthz, resolve, store_list])
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::KeyVersion;
    use crate::paths::{key_device, key_profile};
    use crate::profile::{KdfParams, Profile};
    use crate::store::Store;
    use crate::store_mem::MemStore;
    use crate::token;
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
}
