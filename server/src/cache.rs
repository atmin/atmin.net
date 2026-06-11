//! In-process TTL caches for the authentication hot path.
//!
//! The guard checks two things per authed request that would otherwise be an S3
//! round-trip each: the device file still exists (revocation) and the profile's
//! current `key_version` (ADR-0012). Both are read-mostly and tolerate a short
//! staleness window, so each is cached behind an `RwLock` with a small TTL plus an
//! explicit `invalidate` the mutating handlers call (device delete/revoke,
//! rotate-keys). The TTL is the multi-instance safety net — if another instance
//! mutates, this one self-heals within the window. (Single-instance today; the
//! shared-state migration is a future ADR, as with the EventHub / keyed mutex.)
//!
//! `Instant`-based aging (monotonic), not wall-clock — these measure elapsed time,
//! not a point in time.

use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

/// How long a device-existence check stays trusted.
pub const DEVICE_CACHE_TTL: Duration = Duration::from_secs(30);
/// How long a cached `key_version` stays trusted.
pub const PROFILE_CACHE_TTL: Duration = Duration::from_secs(5);

/// Remembers that a device file existed, keyed by its S3 key, so the guard can
/// skip the `HeadObject` for a recently seen device.
pub struct DeviceCache {
    ttl: Duration,
    seen: RwLock<HashMap<String, Instant>>,
}

impl DeviceCache {
    pub fn new() -> DeviceCache {
        DeviceCache::with_ttl(DEVICE_CACHE_TTL)
    }

    /// Construct with a custom TTL (tests use `Duration::ZERO` to force staleness).
    pub fn with_ttl(ttl: Duration) -> DeviceCache {
        DeviceCache {
            ttl,
            seen: RwLock::new(HashMap::new()),
        }
    }

    /// True iff `key` was `set` within the TTL window.
    pub fn valid(&self, key: &str) -> bool {
        self.seen
            .read()
            .unwrap()
            .get(key)
            .is_some_and(|seen_at| seen_at.elapsed() < self.ttl)
    }

    pub fn set(&self, key: &str) {
        self.seen
            .write()
            .unwrap()
            .insert(key.to_string(), Instant::now());
    }

    pub fn invalidate(&self, key: &str) {
        self.seen.write().unwrap().remove(key);
    }
}

impl Default for DeviceCache {
    fn default() -> DeviceCache {
        DeviceCache::new()
    }
}

/// Caches the current `profile.key_version` per uid, so the guard's kv check skips
/// an S3 GET. The rotate-keys handler invalidates locally on success; the TTL
/// covers the cross-instance case.
pub struct ProfileCache {
    ttl: Duration,
    entries: RwLock<HashMap<String, (u32, Instant)>>,
}

impl ProfileCache {
    pub fn new() -> ProfileCache {
        ProfileCache::with_ttl(PROFILE_CACHE_TTL)
    }

    pub fn with_ttl(ttl: Duration) -> ProfileCache {
        ProfileCache {
            ttl,
            entries: RwLock::new(HashMap::new()),
        }
    }

    /// The cached `key_version` if a fresh entry exists, else `None` (miss/expired).
    pub fn get(&self, uid: &str) -> Option<u32> {
        match self.entries.read().unwrap().get(uid) {
            Some((kv, at)) if at.elapsed() < self.ttl => Some(*kv),
            _ => None,
        }
    }

    pub fn set(&self, uid: &str, key_version: u32) {
        self.entries
            .write()
            .unwrap()
            .insert(uid.to_string(), (key_version, Instant::now()));
    }

    pub fn invalidate(&self, uid: &str) {
        self.entries.write().unwrap().remove(uid);
    }
}

impl Default for ProfileCache {
    fn default() -> ProfileCache {
        ProfileCache::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn device_cache_set_valid_invalidate() {
        let c = DeviceCache::new();
        assert!(!c.valid("k")); // miss
        c.set("k");
        assert!(c.valid("k")); // fresh hit
        c.invalidate("k");
        assert!(!c.valid("k")); // gone
    }

    #[test]
    fn device_cache_expires() {
        // Zero TTL: any elapsed time (>0) is already stale.
        let c = DeviceCache::with_ttl(Duration::ZERO);
        c.set("k");
        assert!(!c.valid("k"));
    }

    #[test]
    fn profile_cache_set_get_invalidate() {
        let c = ProfileCache::new();
        assert_eq!(c.get("u"), None); // miss
        c.set("u", 3);
        assert_eq!(c.get("u"), Some(3)); // fresh hit
        c.invalidate("u");
        assert_eq!(c.get("u"), None); // gone
    }

    #[test]
    fn profile_cache_expires() {
        let c = ProfileCache::with_ttl(Duration::ZERO);
        c.set("u", 3);
        assert_eq!(c.get("u"), None);
    }
}
