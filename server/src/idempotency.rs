//! Persisted rotation outcomes for idempotent replay.
//!
//! `POST /v1/rotate-keys` records its outcome under the client's `request_id`, so
//! a retry after a network timeout replays the recorded result rather than
//! failing the (already-applied) rotation with a `key_version_stale` (ADR-0012 —
//! Idempotency). Records are swept after a 24h TTL by the cleanup job.
//!
//! Unlike the cross-implementation wire formats, this record is read back only by
//! this server, so the on-disk shape is ours to choose: `Option` fields, which
//! keep a success record (token set, error unset) distinct from a failure record
//! by construction. The handler ([`crate::routes`]) owns the mapping to/from its
//! response outcome.

use crate::store::{SharedStore, StoreError};
use serde::{Deserialize, Serialize};

/// The recorded result of one rotation request.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RotationRecord {
    /// HTTP status the original request produced (200 / 409 / 403).
    pub status: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key_version: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<i64>,
}

/// Load a record, or `None` if absent. A backend/parse failure is also surfaced
/// as `Err`, but the caller treats any non-hit as "proceed fresh".
pub async fn load_rotation_record(
    store: &SharedStore,
    key: &str,
) -> Result<Option<RotationRecord>, StoreError> {
    match store.get_object(key).await {
        Ok(bytes) => {
            let rec =
                serde_json::from_slice(&bytes).map_err(|e| StoreError::Backend(Box::new(e)))?;
            Ok(Some(rec))
        }
        Err(StoreError::NotFound) => Ok(None),
        Err(e) => Err(e),
    }
}

/// Persist a record under `key`.
pub async fn save_rotation_record(
    store: &SharedStore,
    key: &str,
    rec: &RotationRecord,
) -> Result<(), StoreError> {
    let body = serde_json::to_vec(rec).map_err(|e| StoreError::Backend(Box::new(e)))?;
    store.put_object(key, &body, "application/json").await
}
