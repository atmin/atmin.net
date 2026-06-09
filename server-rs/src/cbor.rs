//! CBOR archive: array of envelope objects, deduplicated by `msg_id`.
//!
//! Mirrors the compaction path in `server/handlers.go` (`fxamacker/cbor`
//! marshal/unmarshal of `[]any`). The Rust side uses `ciborium` and must decode
//! a Go-marshaled archive to correct values; a Go-decode of a Rust-marshaled
//! archive must match semantically (byte-identity is a stretch finding).
//!
//! TODO(phase 1, step 4): implement decode/encode + the Go↔Rust round-trip.
//! See `tasks/rust-backend-spike.md`.
