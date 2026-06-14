//! S3-backed [`Store`] for production, built on the official `aws-sdk-s3`.
//! MinIO/Scaleway compatibility comes from three knobs: a custom endpoint,
//! path-style addressing, and static credentials.
//!
//! Not unit-tested: there's no in-process S3 to exercise it against. It's
//! compile-checked here and validated end-to-end against MinIO by the Playwright
//! suite. Handler logic is covered via `MemStore`.

use crate::config::S3Config;
use crate::store::{ListPage, ObjectSizes, Store, StoreError};
use async_trait::async_trait;
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::types::{Delete, ObjectIdentifier};
use aws_sdk_s3::Client;
use std::time::Duration;

/// Wraps the S3 client + bucket. A separate `presigner` client points at the
/// browser-reachable endpoint so presigned URLs are usable from the client
/// (this matters when `S3_PUBLIC_ENDPOINT` differs from `S3_ENDPOINT`).
pub struct S3Store {
    client: Client,
    presigner: Client,
    bucket: String,
}

/// Build an S3 client config for `endpoint`. Static creds + explicit region +
/// path-style — no credential-chain discovery. Building the config directly
/// (rather than via `LoadDefaultConfig`) drops the `aws-config` dependency.
fn client_for(cfg: &S3Config, endpoint: &str) -> Client {
    let creds = Credentials::new(
        cfg.access_key.clone(),
        cfg.secret_key.clone(),
        None,
        None,
        "atmin-static",
    );
    let conf = aws_sdk_s3::Config::builder()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(cfg.region.clone()))
        .endpoint_url(endpoint)
        .force_path_style(true) // required for MinIO
        .credentials_provider(creds)
        .build();
    Client::from_conf(conf)
}

impl S3Store {
    /// Construct from loaded [`S3Config`]. Synchronous — building the client is
    /// config-only; network I/O happens per request.
    pub fn new(cfg: &S3Config) -> S3Store {
        let client = client_for(cfg, &cfg.endpoint);
        let presigner = if cfg.public_endpoint == cfg.endpoint {
            client_for(cfg, &cfg.endpoint)
        } else {
            client_for(cfg, &cfg.public_endpoint)
        };
        S3Store {
            client,
            presigner,
            bucket: cfg.bucket.clone(),
        }
    }
}

/// Box any SDK error as a `StoreError::Backend`, logging the full cause chain.
///
/// aws-sdk's `Display` is shallow — a `ServiceError` stringifies to just
/// `"service error"`, hiding the actual cause (NoSuchBucket, a dispatch failure →
/// connection refused, MinIO still starting, …). We walk the `source()` chain and
/// log it here so a resulting 500 is diagnosable from the logs. The client still
/// gets only the generic Internal message (`error.rs` calls `.to_string()` on the
/// boxed error), so S3 internals are never leaked in the response body. Only real
/// failures reach `backend` — the `NotFound` cases are mapped before it.
fn backend<E: std::error::Error + Send + Sync + 'static>(e: E) -> StoreError {
    let mut detail = e.to_string();
    let mut src = e.source();
    while let Some(s) = src {
        detail.push_str(": ");
        detail.push_str(&s.to_string());
        src = s.source();
    }
    log::error!(target: "atmin_server", "msg=s3_error detail={}", crate::logging::logfmt_value(&detail));
    StoreError::Backend(Box::new(e))
}

#[async_trait]
impl Store for S3Store {
    async fn get_object(&self, key: &str) -> Result<Vec<u8>, StoreError> {
        let out = self
            .client
            .get_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| {
                if e.as_service_error().is_some_and(|se| se.is_no_such_key()) {
                    StoreError::NotFound
                } else {
                    backend(e)
                }
            })?;
        let data = out.body.collect().await.map_err(backend)?;
        Ok(data.to_vec())
    }

    async fn put_object(
        &self,
        key: &str,
        data: &[u8],
        content_type: &str,
    ) -> Result<(), StoreError> {
        self.client
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .body(ByteStream::from(data.to_vec()))
            .content_type(content_type)
            .send()
            .await
            .map_err(backend)?;
        Ok(())
    }

    async fn head_object(&self, key: &str) -> Result<(), StoreError> {
        self.client
            .head_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(|e| {
                if e.as_service_error().is_some_and(|se| se.is_not_found()) {
                    StoreError::NotFound
                } else {
                    backend(e)
                }
            })?;
        Ok(())
    }

    async fn delete_object(&self, key: &str) -> Result<(), StoreError> {
        self.client
            .delete_object()
            .bucket(&self.bucket)
            .key(key)
            .send()
            .await
            .map_err(backend)?;
        Ok(())
    }

    async fn delete_objects(&self, keys: &[String]) -> Result<(), StoreError> {
        if keys.is_empty() {
            return Ok(());
        }
        let objects = keys
            .iter()
            .map(|k| ObjectIdentifier::builder().key(k).build().map_err(backend))
            .collect::<Result<Vec<_>, _>>()?;
        let delete = Delete::builder()
            .set_objects(Some(objects))
            .quiet(true)
            .build()
            .map_err(backend)?;
        self.client
            .delete_objects()
            .bucket(&self.bucket)
            .delete(delete)
            .send()
            .await
            .map_err(backend)?;
        Ok(())
    }

    async fn list_objects(
        &self,
        prefix: &str,
        limit: usize,
        cursor: Option<&str>,
    ) -> Result<ListPage, StoreError> {
        let mut req = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(prefix)
            .max_keys(limit as i32);
        if let Some(c) = cursor {
            req = req.start_after(c);
        }
        let out = req.send().await.map_err(backend)?;

        let keys: Vec<String> = out
            .contents()
            .iter()
            .filter_map(|o| o.key().map(String::from))
            .collect();
        // Cursor is the last key only when S3 says more pages follow (matches Go).
        let next_cursor = if out.is_truncated().unwrap_or(false) {
            keys.last().cloned()
        } else {
            None
        };
        Ok(ListPage { keys, next_cursor })
    }

    async fn list_object_sizes(
        &self,
        prefix: &str,
        limit: usize,
    ) -> Result<ObjectSizes, StoreError> {
        let out = self
            .client
            .list_objects_v2()
            .bucket(&self.bucket)
            .prefix(prefix)
            .max_keys(limit as i32)
            .send()
            .await
            .map_err(backend)?;
        let contents = out.contents();
        let total_bytes: u64 = contents
            .iter()
            .map(|o| o.size().unwrap_or(0).max(0) as u64)
            .sum();
        Ok(ObjectSizes {
            total_bytes,
            count: contents.len(),
            truncated: out.is_truncated().unwrap_or(false),
        })
    }

    async fn presign_put(
        &self,
        key: &str,
        content_length: u64,
        ttl: Duration,
    ) -> Result<String, StoreError> {
        let presigned = self
            .presigner
            .put_object()
            .bucket(&self.bucket)
            .key(key)
            .content_length(content_length as i64)
            .presigned(PresigningConfig::expires_in(ttl).map_err(backend)?)
            .await
            .map_err(backend)?;
        Ok(presigned.uri().to_string())
    }
}
