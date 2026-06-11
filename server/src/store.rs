//! Storage interface — the durable-state boundary (ADR-0001). All persistent
//! state lives behind this trait; production is S3, tests use `MemStore`.
//!
//! Async cancellation is structural (drop the future), so there's no `ctx`
//! parameter; list/size results are named structs (`ListPage`, `ObjectSizes`);
//! a missing object is the `StoreError::NotFound` variant.
//!
//! `#[async_trait]` boxes each method's future so the trait is `dyn`-compatible
//! and can be held as `Arc<dyn Store>` — one heap alloc per call, irrelevant next
//! to S3 latency.

use async_trait::async_trait;
use std::sync::Arc;
use std::time::Duration;

/// The storage backend, shared across guards and handlers as Rocket-managed state.
pub type SharedStore = Arc<dyn Store>;

/// Error from a storage operation.
#[derive(Debug)]
pub enum StoreError {
    /// The object does not exist.
    NotFound,
    /// Any other backend failure.
    Backend(Box<dyn std::error::Error + Send + Sync>),
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StoreError::NotFound => f.write_str("not found"),
            StoreError::Backend(e) => write!(f, "storage backend error: {e}"),
        }
    }
}

impl std::error::Error for StoreError {}

/// One page of a `list_objects` call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ListPage {
    pub keys: Vec<String>,
    /// `Some(cursor)` if more keys exist beyond this page; `None` when exhausted.
    pub next_cursor: Option<String>,
}

/// Aggregate sizes from `list_object_sizes`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ObjectSizes {
    pub total_bytes: u64,
    pub count: usize,
    /// True if more keys exist beyond `limit` (single page).
    pub truncated: bool,
}

#[async_trait]
pub trait Store: Send + Sync {
    /// Fetch an object. `Err(StoreError::NotFound)` if the key is absent.
    async fn get_object(&self, key: &str) -> Result<Vec<u8>, StoreError>;

    async fn put_object(
        &self,
        key: &str,
        data: &[u8],
        content_type: &str,
    ) -> Result<(), StoreError>;

    /// Existence check. `Ok(())` if present, `Err(NotFound)` if absent.
    async fn head_object(&self, key: &str) -> Result<(), StoreError>;

    /// Delete an object. Idempotent — deleting an absent key is not an error.
    async fn delete_object(&self, key: &str) -> Result<(), StoreError>;

    /// Batch delete. Idempotent. No-op on an empty slice.
    async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError>;

    /// List up to `limit` keys under `prefix`, lexicographically ordered.
    /// `cursor` is an exclusive `StartAfter` (`None` starts from the beginning).
    async fn list_objects(
        &self,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<ListPage, StoreError>;

    /// Total bytes + count under `prefix`, up to `limit` keys (single page).
    async fn list_object_sizes(
        &self,
        prefix: &str,
        limit: usize,
    ) -> Result<ObjectSizes, StoreError>;

    /// A presigned PUT URL valid for `ttl`.
    async fn presign_put(
        &self,
        key: &str,
        content_length: u64,
        ttl: Duration,
    ) -> Result<String, StoreError>;
}
