//! atmin backend — Rust port experiment (ADR-0018).
//!
//! Phase 1 is the interop spike: reproduce and verify the Go server's three
//! wire formats (token, auth-proof over JCS, CBOR archive) against golden
//! vectors emitted by the Go + TS code. No HTTP/Rocket surface yet.
//!
//! See `tasks/rust-backend-spike.md`.

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
