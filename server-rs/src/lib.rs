//! atmin backend — Rust port experiment (ADR-0018).
//!
//! Phase 1 is the interop spike: reproduce and verify the Go server's three
//! wire formats (token, auth-proof over JCS, CBOR archive) against golden
//! vectors emitted by the Go + TS code. No HTTP/Rocket surface yet.
//!
//! See `tasks/rust-backend-spike.md`.

pub mod authproof;
pub mod cbor;
pub mod token;
