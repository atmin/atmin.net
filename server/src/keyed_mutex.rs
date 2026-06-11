//! Per-key async serialization. One generic primitive serving both callers that
//! need it: rotation (keyed by uid) and the handle claim (keyed by handle).
//!
//! Why it exists: the object store has no conditional writes, so the
//! GET-VERIFY-WRITE on `profile.json` (rotation) and the GET-then-PUT handle claim
//! (registration) need an out-of-band lock (ADR-0012 — Concurrency control). A
//! single-instance in-process map suffices for now; a multi-instance migration to
//! shared state (Redis `SETNX`, Postgres advisory locks) is a future ADR.
//!
//! A per-key `Semaphore` with one permit is the lock; a refcount keeps the entry
//! alive only while someone holds or waits for it, so a key locked once doesn't
//! pin a slot forever. [`acquire`](KeyedMutex::acquire) returns a [`KeyedGuard`]
//! that releases on `Drop` — leaking the lock is not possible.

use rocket::tokio::sync::{OwnedSemaphorePermit, Semaphore};
use rocket::tokio::time::timeout;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// The acquire timed out — another holder kept the key for longer than the
/// caller was willing to wait. Handlers map this to their own status (register →
/// `registration_unavailable`, rotate-keys → its precondition outcome).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Contention;

#[derive(Default)]
struct Inner {
    slots: Mutex<HashMap<String, Slot>>,
}

struct Slot {
    sem: Arc<Semaphore>,
    /// Live holders + waiters. Guarded by `Inner::slots`, not atomic — every
    /// read/write happens under that lock, so the increment-then-remove is atomic.
    refcount: usize,
}

impl Inner {
    fn decrement(&self, key: &str) {
        let mut slots = self.slots.lock().unwrap();
        if let Some(slot) = slots.get_mut(key) {
            slot.refcount -= 1;
            if slot.refcount == 0 {
                slots.remove(key);
            }
        }
    }
}

/// A per-key mutex map. Cheap to clone (it's an `Arc` inside) and `Send + Sync`,
/// so it lives as Rocket-managed state.
#[derive(Clone, Default)]
pub struct KeyedMutex {
    inner: Arc<Inner>,
}

impl KeyedMutex {
    pub fn new() -> KeyedMutex {
        KeyedMutex::default()
    }

    /// Acquire the lock for `key`, waiting up to `timeout`. The returned guard
    /// holds the lock until dropped; on timeout returns [`Contention`] without
    /// acquiring. Concurrent calls for *different* keys never contend.
    pub async fn acquire(&self, key: &str, wait: Duration) -> Result<KeyedGuard, Contention> {
        // Bump the refcount and grab the key's semaphore under the map lock (held
        // only for this, never across the await below).
        let sem = {
            let mut slots = self.inner.slots.lock().unwrap();
            let slot = slots.entry(key.to_string()).or_insert_with(|| Slot {
                sem: Arc::new(Semaphore::new(1)),
                refcount: 0,
            });
            slot.refcount += 1;
            slot.sem.clone()
        };

        // `acquire_owned` is infallible here (we never close the semaphore); a
        // timeout is the only non-acquire outcome.
        match timeout(wait, sem.acquire_owned()).await {
            Ok(Ok(permit)) => Ok(KeyedGuard {
                inner: self.inner.clone(),
                key: key.to_string(),
                _permit: permit,
            }),
            _ => {
                self.inner.decrement(key);
                Err(Contention)
            }
        }
    }

    /// Number of live lock slots — for tests/observability.
    pub fn len(&self) -> usize {
        self.inner.slots.lock().unwrap().len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Held lock for one key. Releasing is automatic: on `Drop` it returns the permit
/// (waking the next waiter) and decrements the refcount, dropping the slot when it
/// reaches zero.
pub struct KeyedGuard {
    inner: Arc<Inner>,
    key: String,
    /// Released when this guard drops; the field exists only to own the permit.
    _permit: OwnedSemaphorePermit,
}

impl Drop for KeyedGuard {
    fn drop(&mut self) {
        // Refcount bookkeeping; the permit field releases as the struct drops.
        self.inner.decrement(&self.key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn different_keys_do_not_contend() {
        let km = KeyedMutex::new();
        let _a = km.acquire("a", Duration::from_millis(50)).await.unwrap();
        // A different key acquires immediately even while "a" is held.
        let _b = km.acquire("b", Duration::from_millis(50)).await.unwrap();
        assert_eq!(km.len(), 2);
    }

    #[tokio::test]
    async fn same_key_while_held_times_out() {
        let km = KeyedMutex::new();
        let held = km.acquire("k", Duration::from_millis(50)).await.unwrap();
        // Second acquire for the same key can't proceed while `held` lives.
        let again = km.acquire("k", Duration::from_millis(20)).await;
        assert_eq!(again.err(), Some(Contention));
        // The contended attempt didn't leak a refcount: only `held` remains.
        assert_eq!(km.len(), 1);
        drop(held);
    }

    #[tokio::test]
    async fn released_guard_allows_reacquire() {
        let km = KeyedMutex::new();
        let g = km.acquire("k", Duration::from_millis(50)).await.unwrap();
        drop(g);
        // Released → the next acquire succeeds without waiting out the timeout.
        let _g2 = km.acquire("k", Duration::from_millis(20)).await.unwrap();
        assert_eq!(km.len(), 1);
    }

    #[tokio::test]
    async fn refcount_cleans_up_to_empty() {
        let km = KeyedMutex::new();
        {
            let _g = km.acquire("k", Duration::from_millis(50)).await.unwrap();
            assert_eq!(km.len(), 1);
        }
        // Last holder gone → slot removed, no leak.
        assert!(km.is_empty());
    }
}
