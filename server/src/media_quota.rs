//! Per-user media quota.
//!
//! In-process for now — the same "in-process now, shared state later" pattern as
//! the EventHub (ADR-0004). A Redis-backed implementation can swap in behind the
//! [`MediaQuota`] trait without touching handlers.
//!
//! Two-tier locking: an outer `std::sync::Mutex` guards the map only briefly
//! (never across an `.await`), handing out a cloned `Arc<tokio::Mutex<…>>` per
//! user. The per-user async lock *is* held across the S3 probe, so concurrent
//! uploads for one user serialize — they don't double-probe, and the optimistic
//! increment stays atomic.

use crate::paths::prefix_media;
use crate::store::{SharedStore, StoreError};
use async_trait::async_trait;
use chrono::{DateTime, Duration, Utc};
use rocket::tokio::sync::Mutex as AsyncMutex;
use std::collections::HashMap;
use std::sync::{Arc, Mutex as StdMutex};

/// Max size of a single media blob: 25 MiB (ciphertext length).
pub const MAX_MEDIA_BYTES: u64 = 25 * 1024 * 1024;
/// Per-user media quota: 1 GiB.
pub const USER_MEDIA_QUOTA_BYTES: u64 = 1 << 30;
/// Per-user blob count cap: one `ListObjectsV2` page.
pub const USER_MEDIA_BLOB_CAP: usize = 1000;
/// Cached usage TTL: 10 minutes.
const QUOTA_CACHE_TTL_SECS: i64 = 600;

/// Outcome of [`MediaQuota::reserve_upload`]. `DeniedBytes`/`DeniedCount` both
/// surface to clients as the same 413 `quota_exceeded`; splitting them keeps the
/// cause inspectable for logging.
#[derive(Debug, PartialEq, Eq)]
pub enum Reservation {
    Granted,
    DeniedBytes,
    DeniedCount,
}

/// Per-user quota cache + reservation.
#[async_trait]
pub trait MediaQuota: Send + Sync {
    /// Check quota + cap and optimistically increment usage. `Granted` permits
    /// the upload; a `Denied*` does not increment.
    async fn reserve_upload(&self, user_id: &str, bytes: u64) -> Result<Reservation, StoreError>;

    /// Current usage `(bytes, count)`, read from the same cache `reserve_upload`
    /// writes — re-probed from S3 on a miss/expiry. Never increments.
    async fn get_usage(&self, user_id: &str) -> Result<(u64, usize), StoreError>;

    /// Expire a user's cached entry so the next access re-probes S3. Called after
    /// a media delete — the handler has only the key, not the byte size, so it
    /// can't decrement precisely; invalidating closes the stale-overcount window
    /// to "until the next access" instead of the full TTL.
    async fn invalidate(&self, user_id: &str);
}

/// Shared quota handle, managed by Rocket like [`crate::store::SharedStore`].
pub type SharedQuota = Arc<dyn MediaQuota>;

#[derive(Default)]
struct QuotaEntry {
    usage_bytes: u64,
    blob_count: usize,
    /// `None` until first populated (and after [`MediaQuota::invalidate`]) — both
    /// mean "expired", forcing a re-probe.
    expires_at: Option<DateTime<Utc>>,
}

/// The v0.1 single-instance quota store. See ADR-0004 for the multi-instance plan.
pub struct InProcessMediaQuota {
    store: SharedStore,
    entries: StdMutex<HashMap<String, Arc<AsyncMutex<QuotaEntry>>>>,
    /// Injectable clock — tests drive TTL.
    now: Box<dyn Fn() -> DateTime<Utc> + Send + Sync>,
}

impl InProcessMediaQuota {
    pub fn new(store: SharedStore) -> InProcessMediaQuota {
        InProcessMediaQuota {
            store,
            entries: StdMutex::new(HashMap::new()),
            now: Box::new(Utc::now),
        }
    }

    /// Get-or-create the per-user entry. Holds the map lock only to clone out the
    /// `Arc` — never across an `.await`.
    fn entry_for(&self, user_id: &str) -> Arc<AsyncMutex<QuotaEntry>> {
        self.entries
            .lock()
            .unwrap()
            .entry(user_id.to_string())
            .or_insert_with(|| Arc::new(AsyncMutex::new(QuotaEntry::default())))
            .clone()
    }

    /// Re-probe S3 into `e` if its cache has expired. The probe runs while the
    /// caller holds the per-user lock (intentional: serializes same-user refreshes).
    async fn refresh_if_expired(
        &self,
        user_id: &str,
        e: &mut QuotaEntry,
    ) -> Result<(), StoreError> {
        let now = (self.now)();
        if e.expires_at.is_none_or(|exp| now > exp) {
            let sizes = self
                .store
                .list_object_sizes(&prefix_media(user_id), USER_MEDIA_BLOB_CAP)
                .await?;
            if sizes.truncated {
                log::warn!(
                    "media_quota.list_truncated user_id={user_id} count={}",
                    sizes.count
                );
            }
            e.usage_bytes = sizes.total_bytes;
            e.blob_count = sizes.count;
            e.expires_at = Some(now + Duration::seconds(QUOTA_CACHE_TTL_SECS));
        }
        Ok(())
    }
}

#[async_trait]
impl MediaQuota for InProcessMediaQuota {
    async fn reserve_upload(&self, user_id: &str, bytes: u64) -> Result<Reservation, StoreError> {
        let entry = self.entry_for(user_id);
        let mut e = entry.lock().await;
        self.refresh_if_expired(user_id, &mut e).await?;

        if e.blob_count + 1 > USER_MEDIA_BLOB_CAP {
            return Ok(Reservation::DeniedCount);
        }
        if e.usage_bytes + bytes > USER_MEDIA_QUOTA_BYTES {
            return Ok(Reservation::DeniedBytes);
        }
        // Optimistic increment; not reverted on unused presigns, rebuilt on TTL refresh.
        e.usage_bytes += bytes;
        e.blob_count += 1;
        Ok(Reservation::Granted)
    }

    async fn get_usage(&self, user_id: &str) -> Result<(u64, usize), StoreError> {
        let entry = self.entry_for(user_id);
        let mut e = entry.lock().await;
        self.refresh_if_expired(user_id, &mut e).await?;
        Ok((e.usage_bytes, e.blob_count))
    }

    async fn invalidate(&self, user_id: &str) {
        // Clone the Arc out under the map lock, then take the async lock — never
        // hold the std mutex across the await.
        let entry = self.entries.lock().unwrap().get(user_id).cloned();
        if let Some(entry) = entry {
            entry.lock().await.expires_at = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store_mem::MemStore;

    fn quota_with(store: MemStore) -> InProcessMediaQuota {
        InProcessMediaQuota::new(Arc::new(store))
    }

    async fn put_media(store: &SharedStore, user_id: &str, name: &str, len: usize) {
        store
            .put_object(
                &format!("{}{name}", prefix_media(user_id)),
                &vec![0u8; len],
                "application/octet-stream",
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn reserve_within_quota_grants_and_increments() {
        let q = quota_with(MemStore::new());
        assert_eq!(
            q.reserve_upload("u", 100).await.unwrap(),
            Reservation::Granted
        );
        assert_eq!(
            q.reserve_upload("u", 50).await.unwrap(),
            Reservation::Granted
        );
        // Optimistic increments accumulate across calls.
        assert_eq!(q.get_usage("u").await.unwrap(), (150, 2));
    }

    #[tokio::test]
    async fn reserve_over_bytes_is_denied() {
        let q = quota_with(MemStore::new());
        assert_eq!(
            q.reserve_upload("u", USER_MEDIA_QUOTA_BYTES + 1)
                .await
                .unwrap(),
            Reservation::DeniedBytes
        );
        // Denied → no increment.
        assert_eq!(q.get_usage("u").await.unwrap(), (0, 0));
    }

    #[tokio::test]
    async fn reserve_over_blob_cap_is_denied() {
        let q = quota_with(MemStore::new());
        // Fill exactly to the cap — each within the byte quota (1 byte apiece).
        for _ in 0..USER_MEDIA_BLOB_CAP {
            assert_eq!(
                q.reserve_upload("u", 1).await.unwrap(),
                Reservation::Granted
            );
        }
        // The cap+1th is denied on count, checked before the byte comparison.
        assert_eq!(
            q.reserve_upload("u", 1).await.unwrap(),
            Reservation::DeniedCount
        );
        // Denied → no increment past the cap.
        assert_eq!(
            q.get_usage("u").await.unwrap(),
            (USER_MEDIA_BLOB_CAP as u64, USER_MEDIA_BLOB_CAP)
        );
    }

    #[tokio::test]
    async fn get_usage_probes_existing_s3_blobs() {
        let store = MemStore::new();
        let q = quota_with(store);
        // Seed media directly via the shared store the quota probes.
        put_media(&q.store, "u", "01A", 300).await;
        put_media(&q.store, "u", "01B", 200).await;
        assert_eq!(q.get_usage("u").await.unwrap(), (500, 2));
    }

    #[tokio::test]
    async fn invalidate_forces_reprobe() {
        let store = MemStore::new();
        let q = quota_with(store);
        put_media(&q.store, "u", "01A", 300).await;
        assert_eq!(q.get_usage("u").await.unwrap(), (300, 1));

        // Add a blob behind the cache's back — stale read still sees the old total.
        put_media(&q.store, "u", "01B", 200).await;
        assert_eq!(q.get_usage("u").await.unwrap(), (300, 1));

        // After invalidate the next access re-probes and sees both.
        q.invalidate("u").await;
        assert_eq!(q.get_usage("u").await.unwrap(), (500, 2));
    }

    #[tokio::test]
    async fn cache_expiry_reprobes_after_ttl() {
        use std::sync::atomic::{AtomicI64, Ordering};
        let clock = Arc::new(AtomicI64::new(0));
        let c = clock.clone();
        let q = InProcessMediaQuota {
            store: Arc::new(MemStore::new()),
            entries: StdMutex::new(HashMap::new()),
            now: Box::new(move || DateTime::from_timestamp(c.load(Ordering::SeqCst), 0).unwrap()),
        };
        put_media(&q.store, "u", "01A", 300).await;
        assert_eq!(q.get_usage("u").await.unwrap(), (300, 1));

        // Within TTL: cached, ignores the new blob.
        put_media(&q.store, "u", "01B", 200).await;
        clock.store(QUOTA_CACHE_TTL_SECS - 1, Ordering::SeqCst);
        assert_eq!(q.get_usage("u").await.unwrap(), (300, 1));

        // Past TTL: re-probes.
        clock.store(QUOTA_CACHE_TTL_SECS + 1, Ordering::SeqCst);
        assert_eq!(q.get_usage("u").await.unwrap(), (500, 2));
    }
}
