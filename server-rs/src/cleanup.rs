//! Data-retention cleanup (ADR-0006 + ADR-0013). Mirrors `server/cleanup.go`.
//!
//! A single idempotent sweep over `handles/` that removes three kinds of dead
//! data:
//!   - **Abandoned** registrations — no `display_name`, no messages, older than a
//!     7-day grace period (test accounts / abandoned signups).
//!   - **Inactive** users — `last_active` older than the configured threshold.
//!   - **Expired tombstones** — a deleted handle past its 30-day cooldown
//!     (ADR-0013) is claimable again, so its reservation file is dead weight.
//!
//! Pure `Store` operations — no HTTP. Invoked from the `cleanup` subcommand
//! ([`crate::main`]) on a schedule (a Scaleway Serverless Job), never in-process:
//! the server is stateless and only one instance should sweep.

use crate::paths::{
    key_handle, key_profile, prefix_inbox, prefix_inbox_archive, prefix_inbox_live, prefix_keys,
    prefix_media, prefix_user,
};
use crate::profile::{Profile, PublicHandleData};
use crate::store::{SharedStore, StoreError};
use chrono::{DateTime, Duration, Utc};

/// Fixed grace window after registration before an abandoned account is eligible
/// (ADR-0006). Only the inactive threshold is configurable.
const ABANDONED_GRACE_DAYS: i64 = 7;
/// Post-deletion handle reservation window (ADR-0013). Mirrors the same constant
/// in `routes.rs` — both descend from ADR-0013 (dedupe in the cleanup pass).
const HANDLE_COOLDOWN_DAYS: i64 = 30;
/// One `handles/` listing page.
const HANDLES_PAGE_SIZE: usize = 1000;
/// One wipe page in `delete_user`.
const WIPE_PAGE_SIZE: usize = 1000;

/// Tunables + injected clock for one cleanup run.
pub struct CleanupOpts {
    pub inactive_days: i64,
    /// Max users deleted per run (caps deletes, not scans).
    pub batch_size: usize,
    /// `true` = log matches only, delete nothing.
    pub dry_run: bool,
    /// Captured once by the caller (tests pass a fixed instant).
    pub now: DateTime<Utc>,
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct CleanupResult {
    pub handles_scanned: usize,
    pub abandoned: usize,
    pub inactive: usize,
    pub tombstones: usize,
    /// Actual deletions, or would-be deletions under `dry_run`.
    pub deleted: usize,
    pub errors: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Policy {
    Abandoned,
    Inactive,
    Tombstone,
}

/// Sweep `handles/` once, deleting up to `batch_size` matches. Idempotent.
pub async fn run_cleanup(
    store: &SharedStore,
    opts: &CleanupOpts,
) -> Result<CleanupResult, StoreError> {
    let mut res = CleanupResult::default();
    let mut cursor: Option<String> = None;

    while res.deleted < opts.batch_size {
        let page = store
            .list_objects("handles/", HANDLES_PAGE_SIZE, cursor.as_deref())
            .await?;

        for k in &page.keys {
            res.handles_scanned += 1;
            if res.deleted >= opts.batch_size {
                break;
            }
            let evaluated = match evaluate_user(store, k, opts).await {
                Ok(v) => v,
                Err(e) => {
                    res.errors += 1;
                    log::warn!("cleanup.evaluate_failed key={k} err={e}");
                    continue;
                }
            };
            let Some((policy, profile)) = evaluated else {
                continue; // keep
            };
            match policy {
                Policy::Abandoned => res.abandoned += 1,
                Policy::Inactive => res.inactive += 1,
                Policy::Tombstone => res.tombstones += 1,
            }
            let uid = profile.as_ref().map_or("", |p| p.user_id.as_str());
            log::info!(
                "cleanup.match key={k} user_id={uid} policy={policy:?} dry_run={}",
                opts.dry_run
            );

            if !opts.dry_run {
                // A tombstone is just the handle file; a user is a full wipe.
                let deleted = match policy {
                    Policy::Tombstone => store.delete_object(k).await,
                    _ => delete_user(store, profile.as_ref().unwrap()).await,
                };
                if let Err(e) = deleted {
                    res.errors += 1;
                    log::warn!("cleanup.delete_failed key={k} user_id={uid} err={e}");
                    continue;
                }
            }
            res.deleted += 1;
        }

        match page.next_cursor {
            Some(c) => cursor = Some(c),
            None => break,
        }
    }
    Ok(res)
}

/// Classify one handle file. `None` = keep. A tombstone or a handle pointing at a
/// missing profile is kept unless it's an *expired* tombstone. Mirrors `evaluateUser`.
async fn evaluate_user(
    store: &SharedStore,
    handle_key: &str,
    opts: &CleanupOpts,
) -> Result<Option<(Policy, Option<Profile>)>, StoreError> {
    let data = store.get_object(handle_key).await?;
    let h: PublicHandleData =
        serde_json::from_slice(&data).map_err(|e| StoreError::Backend(Box::new(e)))?;
    let now = opts.now;

    // A tombstone has no user_id (ADR-0013 reservation). Sweep it once past the
    // cooldown; a malformed/empty one (no released_at) is left alone.
    if h.user_id.is_empty() {
        if h.released_at.is_empty() {
            return Ok(None);
        }
        let released = DateTime::parse_from_rfc3339(&h.released_at)
            .map_err(|e| StoreError::Backend(Box::new(e)))?
            .with_timezone(&Utc);
        if now - released > Duration::days(HANDLE_COOLDOWN_DAYS) {
            return Ok(Some((Policy::Tombstone, None)));
        }
        return Ok(None);
    }

    let profile = match store.get_object(&key_profile(&h.user_id)).await {
        Ok(b) => {
            serde_json::from_slice::<Profile>(&b).map_err(|e| StoreError::Backend(Box::new(e)))?
        }
        // Dangling handle → missing profile. Not a retention match; leave it.
        Err(StoreError::NotFound) => return Ok(None),
        Err(e) => return Err(e),
    };

    // Abandoned (checked first — catches never-active signups whose last_active is
    // empty): no display_name, past the grace period, empty inbox.
    if profile.display_name.is_empty() {
        if let Ok(created) = DateTime::parse_from_rfc3339(&profile.created_at) {
            if now - created.with_timezone(&Utc) > Duration::days(ABANDONED_GRACE_DAYS)
                && inbox_empty(store, &h.user_id).await?
            {
                return Ok(Some((Policy::Abandoned, Some(profile))));
            }
        }
    }

    // Inactive: once active, but silent for longer than the threshold.
    if !profile.last_active.is_empty() {
        if let Ok(last) = DateTime::parse_from_rfc3339(&profile.last_active) {
            if now - last.with_timezone(&Utc) > Duration::days(opts.inactive_days) {
                return Ok(Some((Policy::Inactive, Some(profile))));
            }
        }
    }

    Ok(None)
}

/// Whether the user has no live and no archived messages.
async fn inbox_empty(store: &SharedStore, uid: &str) -> Result<bool, StoreError> {
    for prefix in [prefix_inbox_live(uid), prefix_inbox_archive(uid)] {
        let page = store.list_objects(&prefix, 1, None).await?;
        if !page.keys.is_empty() {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Remove everything for a user: all objects under their four prefixes, plus the
/// handle file. Idempotent. Mirrors `deleteUser`.
async fn delete_user(store: &SharedStore, profile: &Profile) -> Result<(), StoreError> {
    let uid = &profile.user_id;
    for prefix in [
        prefix_user(uid),
        prefix_inbox(uid),
        prefix_keys(uid),
        prefix_media(uid),
    ] {
        loop {
            let page = store.list_objects(&prefix, WIPE_PAGE_SIZE, None).await?;
            if page.keys.is_empty() {
                break;
            }
            let n = page.keys.len();
            store.delete_objects(&page.keys).await?;
            // Last page (deletion shrinks the set, so we always list from the start).
            if n < WIPE_PAGE_SIZE {
                break;
            }
        }
    }
    if !profile.handle.is_empty() {
        store.delete_object(&key_handle(&profile.handle)).await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use crate::store_mem::MemStore;
    use chrono::SecondsFormat;
    use std::sync::Arc;

    const NOW: &str = "2026-06-11T00:00:00Z";

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(NOW)
            .unwrap()
            .with_timezone(&Utc)
    }

    /// An RFC3339 timestamp `days` before NOW.
    fn days_ago(days: i64) -> String {
        (now() - Duration::days(days)).to_rfc3339_opts(SecondsFormat::Secs, true)
    }

    async fn put<T: serde::Serialize>(store: &MemStore, key: &str, value: &T) {
        store
            .put_object(key, &serde_json::to_vec(value).unwrap(), "application/json")
            .await
            .unwrap();
    }

    /// Seed handle + profile for a live account.
    async fn seed_account(
        store: &MemStore,
        handle: &str,
        uid: &str,
        display_name: &str,
        created: &str,
        last_active: &str,
    ) {
        put(
            store,
            &key_handle(handle),
            &PublicHandleData {
                user_id: uid.into(),
                ..Default::default()
            },
        )
        .await;
        put(
            store,
            &key_profile(uid),
            &Profile {
                user_id: uid.into(),
                handle: handle.into(),
                display_name: display_name.into(),
                created_at: created.into(),
                last_active: last_active.into(),
                key_version: 1,
                ..Default::default()
            },
        )
        .await;
    }

    async fn seed_tombstone(store: &MemStore, handle: &str, released_at: &str) {
        put(
            store,
            &key_handle(handle),
            &PublicHandleData {
                released_at: released_at.into(),
                ..Default::default()
            },
        )
        .await;
    }

    fn opts(dry_run: bool, batch_size: usize) -> CleanupOpts {
        CleanupOpts {
            inactive_days: 180,
            batch_size,
            dry_run,
            now: now(),
        }
    }

    async fn run(store: MemStore, opts: CleanupOpts) -> (CleanupResult, SharedStore) {
        let shared: SharedStore = Arc::new(store);
        let res = run_cleanup(&shared, &opts).await.unwrap();
        (res, shared)
    }

    #[tokio::test]
    async fn expired_tombstone_is_swept() {
        let store = MemStore::new();
        seed_tombstone(&store, "gone", &days_ago(31)).await; // past 30d cooldown
        let (res, shared) = run(store, opts(false, 100)).await;
        assert_eq!(res.tombstones, 1);
        assert_eq!(res.deleted, 1);
        assert!(shared.head_object(&key_handle("gone")).await.is_err());
    }

    #[tokio::test]
    async fn tombstone_in_cooldown_is_kept() {
        let store = MemStore::new();
        seed_tombstone(&store, "soon", &days_ago(10)).await; // still reserved
        let (res, shared) = run(store, opts(false, 100)).await;
        assert_eq!(res.tombstones, 0);
        assert_eq!(res.deleted, 0);
        assert!(shared.head_object(&key_handle("soon")).await.is_ok());
    }

    #[tokio::test]
    async fn abandoned_account_is_wiped() {
        let store = MemStore::new();
        // No display_name, created 8 days ago (past grace), empty inbox.
        seed_account(&store, "ghost", "U_GHOST", "", &days_ago(8), "").await;
        let (res, shared) = run(store, opts(false, 100)).await;
        assert_eq!(res.abandoned, 1);
        assert_eq!(res.deleted, 1);
        // Both the profile and the handle are gone.
        assert!(shared.head_object(&key_profile("U_GHOST")).await.is_err());
        assert!(shared.head_object(&key_handle("ghost")).await.is_err());
    }

    #[tokio::test]
    async fn abandoned_within_grace_is_kept() {
        let store = MemStore::new();
        seed_account(&store, "fresh", "U_FRESH", "", &days_ago(3), "").await; // < 7d
        let (res, _) = run(store, opts(false, 100)).await;
        assert_eq!(res.deleted, 0);
    }

    #[tokio::test]
    async fn abandoned_with_messages_is_kept() {
        let store = MemStore::new();
        seed_account(&store, "busy", "U_BUSY", "", &days_ago(8), "").await;
        // A live message → inbox not empty → not abandoned.
        put(&store, "inbox/U_BUSY/live/m1", &serde_json::json!({"x":1})).await;
        let (res, _) = run(store, opts(false, 100)).await;
        assert_eq!(res.deleted, 0);
    }

    #[tokio::test]
    async fn inactive_account_is_wiped() {
        let store = MemStore::new();
        // Has a display_name (not abandoned), but last_active 200d ago > 180d.
        seed_account(
            &store,
            "old",
            "U_OLD",
            "Olivia",
            &days_ago(400),
            &days_ago(200),
        )
        .await;
        let (res, shared) = run(store, opts(false, 100)).await;
        assert_eq!(res.inactive, 1);
        assert_eq!(res.deleted, 1);
        assert!(shared.head_object(&key_profile("U_OLD")).await.is_err());
    }

    #[tokio::test]
    async fn active_account_is_kept() {
        let store = MemStore::new();
        seed_account(
            &store,
            "live",
            "U_LIVE",
            "Liam",
            &days_ago(400),
            &days_ago(5),
        )
        .await;
        let (res, _) = run(store, opts(false, 100)).await;
        assert_eq!(res.deleted, 0);
    }

    #[tokio::test]
    async fn dry_run_counts_but_deletes_nothing() {
        let store = MemStore::new();
        seed_account(&store, "ghost", "U_GHOST", "", &days_ago(8), "").await;
        let (res, shared) = run(store, opts(true, 100)).await;
        assert_eq!(res.abandoned, 1);
        assert_eq!(res.deleted, 1); // would-be deletion
                                    // ...but the data is still there.
        assert!(shared.head_object(&key_profile("U_GHOST")).await.is_ok());
        assert!(shared.head_object(&key_handle("ghost")).await.is_ok());
    }

    #[tokio::test]
    async fn batch_size_caps_deletions() {
        let store = MemStore::new();
        for i in 0..3 {
            seed_account(
                &store,
                &format!("g{i}"),
                &format!("U{i}"),
                "",
                &days_ago(8),
                "",
            )
            .await;
        }
        let (res, _) = run(store, opts(false, 2)).await; // cap at 2
        assert_eq!(res.deleted, 2);
    }
}
