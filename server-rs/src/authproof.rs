//! Ed25519 auth proof over the JCS-canonical (RFC 8785) bytes of the payload.
//!
//! Mirrors `server/auth.go` (`verifyAuthProof`). The payload
//! `{user_id, device_id, timestamp, key_version}` is canonicalized with JCS and
//! signed with the account's auth key. The production signer is the TS client
//! (`web/src/lib/crypto.ts`, the `canonicalize` package), so the canonical bytes
//! produced here (`serde_jcs`) must match *both* Go and TS byte-for-byte.
//!
//! TODO(phase 1, step 3): implement `canonicalize` + `verify` and assert the
//! canonical-byte battery against Go and TS golden vectors. See
//! `tasks/rust-backend-spike.md`.
