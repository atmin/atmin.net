//! In-memory `Store` for tests. Mirrors `server/store_mem.go`.
//!
//! Backed by a `BTreeMap`, so keys are intrinsically sorted — listing is a
//! filtered scan and matches S3's lexicographic order without an explicit sort.
//!
//! The Go `MemStore`'s fault-injection hooks (`headErr`, `putErr`) are not ported
//! yet; they land with the phase-3 handler tests that need them.

use crate::store::{ListPage, ObjectSizes, Store, StoreError};
use async_trait::async_trait;
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::time::Duration;

#[derive(Default)]
pub struct MemStore {
    objects: Mutex<BTreeMap<String, Vec<u8>>>,
}

impl MemStore {
    pub fn new() -> MemStore {
        MemStore::default()
    }
}

#[async_trait]
impl Store for MemStore {
    async fn get_object(&self, key: &str) -> Result<Vec<u8>, StoreError> {
        self.objects
            .lock()
            .unwrap()
            .get(key)
            .cloned()
            .ok_or(StoreError::NotFound)
    }

    async fn put_object(
        &self,
        key: &str,
        data: &[u8],
        _content_type: &str,
    ) -> Result<(), StoreError> {
        self.objects
            .lock()
            .unwrap()
            .insert(key.to_string(), data.to_vec());
        Ok(())
    }

    async fn head_object(&self, key: &str) -> Result<(), StoreError> {
        if self.objects.lock().unwrap().contains_key(key) {
            Ok(())
        } else {
            Err(StoreError::NotFound)
        }
    }

    async fn delete_object(&self, key: &str) -> Result<(), StoreError> {
        self.objects.lock().unwrap().remove(key);
        Ok(())
    }

    async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError> {
        let mut objs = self.objects.lock().unwrap();
        for k in keys {
            objs.remove(k);
        }
        Ok(())
    }

    async fn list_objects(
        &self,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<ListPage, StoreError> {
        let objs = self.objects.lock().unwrap();
        // BTreeMap yields keys already sorted, so this stays in lexicographic order.
        let mut keys: Vec<String> = objs
            .keys()
            .filter(|k| k.starts_with(prefix) && cursor.is_none_or(|c| k.as_str() > c))
            .cloned()
            .collect();

        if keys.len() > limit {
            keys.truncate(limit);
            let next = keys.last().cloned();
            Ok(ListPage {
                keys,
                next_cursor: next,
            })
        } else {
            Ok(ListPage {
                keys,
                next_cursor: None,
            })
        }
    }

    async fn list_object_sizes(
        &self,
        prefix: &str,
        limit: usize,
    ) -> Result<ObjectSizes, StoreError> {
        let objs = self.objects.lock().unwrap();
        // Sizes in key order (BTreeMap), so taking the first `limit` matches Go.
        let sizes: Vec<u64> = objs
            .iter()
            .filter(|(k, _)| k.starts_with(prefix))
            .map(|(_, v)| v.len() as u64)
            .collect();
        let truncated = sizes.len() > limit;
        let take = sizes.len().min(limit);
        Ok(ObjectSizes {
            total_bytes: sizes[..take].iter().sum(),
            count: take,
            truncated,
        })
    }

    async fn presign_put(
        &self,
        key: &str,
        _content_length: u64,
        _ttl: Duration,
    ) -> Result<String, StoreError> {
        // Tests don't upload through the URL; the write goes via put_object.
        Ok(format!("http://fake-presign/{key}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn put_get_head_delete() {
        let s = MemStore::new();

        assert!(matches!(s.get_object("k").await, Err(StoreError::NotFound)));
        assert!(matches!(
            s.head_object("k").await,
            Err(StoreError::NotFound)
        ));

        s.put_object("k", b"hello", "text/plain").await.unwrap();
        assert_eq!(s.get_object("k").await.unwrap(), b"hello".to_vec());
        s.head_object("k").await.unwrap();

        s.delete_object("k").await.unwrap();
        assert!(matches!(s.get_object("k").await, Err(StoreError::NotFound)));
        // delete is idempotent
        s.delete_object("k").await.unwrap();
    }

    #[tokio::test]
    async fn list_objects_prefix_sorted_paginated() {
        let s = MemStore::new();
        for k in ["a/3", "a/1", "a/2", "b/1"] {
            s.put_object(k, b"x", "").await.unwrap();
        }

        // Prefix filters; results come back sorted.
        let page = s.list_objects("a/", 10, None).await.unwrap();
        assert_eq!(page.keys, ["a/1", "a/2", "a/3"]);
        assert_eq!(page.next_cursor, None);

        // limit 2 → first page + a cursor pointing at the last returned key.
        let page = s.list_objects("a/", 2, None).await.unwrap();
        assert_eq!(page.keys, ["a/1", "a/2"]);
        assert_eq!(page.next_cursor.as_deref(), Some("a/2"));

        // Next page via the exclusive StartAfter cursor.
        let page = s.list_objects("a/", 2, Some("a/2")).await.unwrap();
        assert_eq!(page.keys, ["a/3"]);
        assert_eq!(page.next_cursor, None);
    }

    #[tokio::test]
    async fn list_object_sizes_totals_and_truncation() {
        let s = MemStore::new();
        s.put_object("p/1", b"aaa", "").await.unwrap(); // 3
        s.put_object("p/2", b"bbbbb", "").await.unwrap(); // 5
        s.put_object("other", b"zzzz", "").await.unwrap();

        let sizes = s.list_object_sizes("p/", 10).await.unwrap();
        assert_eq!(sizes.total_bytes, 8);
        assert_eq!(sizes.count, 2);
        assert!(!sizes.truncated);

        // Truncated to the first key in sorted order (p/1).
        let sizes = s.list_object_sizes("p/", 1).await.unwrap();
        assert_eq!(sizes.count, 1);
        assert!(sizes.truncated);
        assert_eq!(sizes.total_bytes, 3);
    }

    #[tokio::test]
    async fn delete_objects_batch() {
        let s = MemStore::new();
        for k in ["x", "y", "z"] {
            s.put_object(k, b"v", "").await.unwrap();
        }
        s.delete_objects(&["x".to_string(), "z".to_string()])
            .await
            .unwrap();
        assert!(matches!(s.get_object("x").await, Err(StoreError::NotFound)));
        assert_eq!(s.get_object("y").await.unwrap(), b"v".to_vec());
        assert!(matches!(s.get_object("z").await, Err(StoreError::NotFound)));
    }

    #[tokio::test]
    async fn presign_returns_a_url() {
        let s = MemStore::new();
        let url = s
            .presign_put("media/abc", 100, Duration::from_secs(60))
            .await
            .unwrap();
        assert_eq!(url, "http://fake-presign/media/abc");
    }
}
