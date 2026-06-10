//! HTTP routes (Rocket). Mirrors `server/routes.go` (`newMux`). Built up through
//! phase 3; `build` mounts whatever handlers exist so far. Production wiring (an
//! S3-backed store, `#[launch]` main) lands in phase 4.

use crate::error::ApiError;
use crate::profile::PublicHandleData;
use crate::store::Store;
use chrono::{DateTime, Duration, SecondsFormat, Utc};
use rocket::serde::json::Json;
use rocket::{get, routes, Build, Rocket, State};
use std::sync::Arc;

/// The storage backend, shared across handlers as Rocket-managed state.
pub type SharedStore = Arc<dyn Store>;

/// Post-deletion handle reservation window (ADR-0013).
const HANDLE_COOLDOWN_DAYS: i64 = 30;

/// Build the Rocket app over a given store. Tests pass a `MemStore`; production
/// will pass an S3-backed store.
pub fn build(store: SharedStore) -> Rocket<Build> {
    rocket::build()
        .manage(store)
        .mount("/", routes![healthz, resolve])
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
    let data = store.get_object(&format!("handles/{handle}.json")).await?;
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
    // are always complete; only legacy data triggered it. Revisit if a scenario
    // exercises an incomplete projection.

    Ok(Json(h))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profile::KdfParams;
    use crate::store_mem::MemStore;
    use rocket::http::Status;
    use rocket::local::asynchronous::Client;

    async fn client_with(store: MemStore) -> Client {
        Client::tracked(build(Arc::new(store))).await.unwrap()
    }

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
            user_id: "01ARZ3NDEKTSV4RRFFQ69G5FAV".into(),
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
        store
            .put_object(
                "handles/alice.json",
                &serde_json::to_vec(&projection).unwrap(),
                "application/json",
            )
            .await
            .unwrap();

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
        store
            .put_object(
                "handles/gone.json",
                &serde_json::to_vec(&tombstone).unwrap(),
                "application/json",
            )
            .await
            .unwrap();

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
            released_at: "2020-01-01T00:00:00Z".into(), // cooldown long elapsed
            ..Default::default()
        };
        store
            .put_object(
                "handles/old.json",
                &serde_json::to_vec(&tombstone).unwrap(),
                "application/json",
            )
            .await
            .unwrap();

        let client = client_with(store).await;
        let resp = client.get("/v1/resolve/old").dispatch().await;
        assert_eq!(resp.status(), Status::NotFound);
    }
}
