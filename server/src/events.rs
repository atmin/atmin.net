//! Server-Sent Events fan-out + the `last_active` updater.
//!
//! One user can have several connected devices, so the hub maps `user_id` → a
//! list of per-connection channels; `notify` fans an event out to all of them.
//! In-process now, shared-state (Redis pub/sub) later — the same trajectory as
//! the quota and caches (ADR-0004).
//!
//! Each connection gets a buffered channel (capacity 10), and sends are
//! **non-blocking** (`try_send`) so a slow device is skipped rather than
//! stalling `notify`. Lifecycle is RAII: [`register`](EventHub::register)
//! returns a [`Subscription`], and dropping it (client disconnects → the SSE
//! stream future drops) unregisters and prunes the user's entry when its last
//! connection goes.

use crate::paths::key_profile;
use crate::profile::Profile;
use crate::store::SharedStore;
use chrono::{DateTime, SecondsFormat, Utc};
use rocket::tokio::sync::mpsc;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// Per-connection channel buffer.
const CHANNEL_BUFFER: usize = 10;

/// Skip refreshing `last_active` if the stored value is younger than this
/// (the 1-hour write-coalescing window).
const LAST_ACTIVE_REFRESH_SECS: i64 = 3600;

struct Conn {
    id: u64,
    tx: mpsc::Sender<String>,
}

#[derive(Default)]
struct HubInner {
    clients: Mutex<HashMap<String, Vec<Conn>>>,
    next_id: AtomicU64,
}

impl HubInner {
    fn unregister(&self, user_id: &str, id: u64) {
        let mut clients = self.clients.lock().unwrap();
        if let Some(conns) = clients.get_mut(user_id) {
            conns.retain(|c| c.id != id);
            if conns.is_empty() {
                clients.remove(user_id);
            }
        }
    }
}

/// SSE fan-out hub. Cheap to clone (an `Arc` inside) and `Send + Sync`, so it
/// lives as Rocket-managed state shared by the `events` and `send` handlers.
#[derive(Clone, Default)]
pub struct EventHub {
    inner: Arc<HubInner>,
}

impl EventHub {
    pub fn new() -> EventHub {
        EventHub::default()
    }

    /// Open a new connection for `user_id`. The returned [`Subscription`] receives
    /// events until dropped (which unregisters it).
    pub fn register(&self, user_id: &str) -> Subscription {
        let (tx, rx) = mpsc::channel(CHANNEL_BUFFER);
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner
            .clients
            .lock()
            .unwrap()
            .entry(user_id.to_string())
            .or_default()
            .push(Conn { id, tx });
        Subscription {
            inner: self.inner.clone(),
            user_id: user_id.to_string(),
            id,
            rx,
        }
    }

    /// Fan `event` out to every connected device for `user_id`. Non-blocking: a
    /// device whose buffer is full is skipped (`try_send`), never awaited.
    pub fn notify(&self, user_id: &str, event: &str) {
        let clients = self.inner.clients.lock().unwrap();
        if let Some(conns) = clients.get(user_id) {
            for c in conns {
                let _ = c.tx.try_send(event.to_string());
            }
        }
    }

    /// Live connection count for `user_id` — for tests/observability.
    pub fn connection_count(&self, user_id: &str) -> usize {
        self.inner
            .clients
            .lock()
            .unwrap()
            .get(user_id)
            .map_or(0, Vec::len)
    }
}

/// A live SSE connection. Holds the receiving end; dropping it unregisters from
/// the hub.
pub struct Subscription {
    inner: Arc<HubInner>,
    user_id: String,
    id: u64,
    rx: mpsc::Receiver<String>,
}

impl Subscription {
    /// Await the next event for this connection. `None` once the hub side is gone.
    pub async fn recv(&mut self) -> Option<String> {
        self.rx.recv().await
    }
}

impl Drop for Subscription {
    fn drop(&mut self) {
        self.inner.unregister(&self.user_id, self.id);
    }
}

/// Refresh `last_active` on the user's profile, skipping if the stored value is
/// less than an hour old. Best-effort: any read/parse/write failure is swallowed
/// (it's a background metadata update, not part of the request's contract).
pub async fn update_last_active(store: &SharedStore, user_id: &str) {
    let key = key_profile(user_id);
    let Ok(bytes) = store.get_object(&key).await else {
        return;
    };
    let Ok(mut profile) = serde_json::from_slice::<Profile>(&bytes) else {
        return;
    };

    if !profile.last_active.is_empty() {
        if let Ok(t) = DateTime::parse_from_rfc3339(&profile.last_active) {
            if (Utc::now() - t.with_timezone(&Utc)).num_seconds() < LAST_ACTIVE_REFRESH_SECS {
                return;
            }
        }
    }

    profile.last_active = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
    if let Ok(out) = serde_json::to_vec(&profile) {
        let _ = store.put_object(&key, &out, "application/json").await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::Store;
    use crate::store_mem::MemStore;

    #[tokio::test]
    async fn notify_reaches_a_registered_connection() {
        let hub = EventHub::new();
        let mut sub = hub.register("u");
        hub.notify("u", "new_message");
        assert_eq!(sub.recv().await, Some("new_message".into()));
    }

    #[tokio::test]
    async fn notify_fans_out_to_all_devices_of_a_user() {
        let hub = EventHub::new();
        let mut a = hub.register("u");
        let mut b = hub.register("u");
        assert_eq!(hub.connection_count("u"), 2);
        hub.notify("u", "new_message");
        assert_eq!(a.recv().await, Some("new_message".into()));
        assert_eq!(b.recv().await, Some("new_message".into()));
    }

    #[tokio::test]
    async fn notify_is_scoped_to_the_user() {
        let hub = EventHub::new();
        let mut other = hub.register("other");
        hub.notify("u", "new_message"); // no connection for "u"
                                        // "other" must not receive it — try_recv is empty.
        assert!(other.rx.try_recv().is_err());
    }

    #[tokio::test]
    async fn dropping_a_subscription_unregisters_and_prunes() {
        let hub = EventHub::new();
        let a = hub.register("u");
        let b = hub.register("u");
        assert_eq!(hub.connection_count("u"), 2);
        drop(a);
        assert_eq!(hub.connection_count("u"), 1); // one left
        drop(b);
        assert_eq!(hub.connection_count("u"), 0); // entry pruned entirely
    }

    async fn seed_profile(store: &MemStore, last_active: &str) {
        let profile = Profile {
            user_id: "u".into(),
            key_version: 1,
            last_active: last_active.into(),
            ..Default::default()
        };
        store
            .put_object(
                &key_profile("u"),
                &serde_json::to_vec(&profile).unwrap(),
                "application/json",
            )
            .await
            .unwrap();
    }

    async fn stored_last_active(store: &SharedStore) -> String {
        let bytes = store.get_object(&key_profile("u")).await.unwrap();
        serde_json::from_slice::<Profile>(&bytes)
            .unwrap()
            .last_active
    }

    #[tokio::test]
    async fn update_last_active_sets_when_empty() {
        let store = MemStore::new();
        seed_profile(&store, "").await;
        let shared: SharedStore = Arc::new(store);
        update_last_active(&shared, "u").await;
        // Now populated with a parseable RFC3339 timestamp.
        let la = stored_last_active(&shared).await;
        assert!(!la.is_empty());
        assert!(DateTime::parse_from_rfc3339(&la).is_ok());
    }

    #[tokio::test]
    async fn update_last_active_skips_when_recent() {
        let store = MemStore::new();
        let recent = Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true);
        seed_profile(&store, &recent).await;
        let shared: SharedStore = Arc::new(store);
        update_last_active(&shared, "u").await;
        // Unchanged — it was younger than the 1h threshold.
        assert_eq!(stored_last_active(&shared).await, recent);
    }

    #[tokio::test]
    async fn update_last_active_refreshes_when_stale() {
        let store = MemStore::new();
        let stale = "2020-01-01T00:00:00Z";
        seed_profile(&store, stale).await;
        let shared: SharedStore = Arc::new(store);
        update_last_active(&shared, "u").await;
        assert_ne!(stored_last_active(&shared).await, stale);
    }
}
