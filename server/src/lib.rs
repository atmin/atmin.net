//! atmin backend: a stateless S3 proxy + SSE hub.
//!
//! All durable state lives in S3 behind the [`store::Store`] trait; the only
//! in-process state is the SSE hub, the device-existence cache, and the
//! media-quota cache (ADR-0001, ADR-0004). The three wire formats — token,
//! auth-proof over JCS, and the CBOR archive — are pinned byte-for-byte against
//! golden vectors shared with the TS client (see `tests/interop.rs`).

pub mod authproof;
pub mod cache;
pub mod cbor;
pub mod cleanup;
pub mod config;
pub mod error;
pub mod events;
pub mod guard;
pub mod idempotency;
pub mod keyed_mutex;
pub mod logging;
pub mod media_quota;
pub mod model;
pub mod paths;
pub mod profile;
pub mod reserved;
pub mod routes;
#[cfg(feature = "embed-spa")]
pub mod spa;
pub mod store;
pub mod store_mem;
pub mod store_s3;
pub mod token;
