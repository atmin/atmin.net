//! Ed25519 auth proof over the JCS-canonical (RFC 8785) bytes of the payload.
//!
//! Mirrors `server/auth.go` (`verifyAuthProof`). The payload
//! `{user_id, device_id, timestamp, key_version}` is canonicalized with JCS and
//! signed with the account's auth key. The production signer is the TS client
//! (`web/src/lib/crypto.ts`, the `canonicalize` package), so the canonical bytes
//! produced here (`serde_jcs`) must match *both* Go and TS byte-for-byte — see
//! the interop battery in `tests/interop.rs`.
//!
//! This module verifies the *signature* only. Freshness (the 5-minute window)
//! and `key_version >= 1` are handler concerns, deferred to phase 3.

use ed25519_dalek::{Signature, VerifyingKey};

#[derive(Debug, PartialEq, Eq)]
pub enum AuthProofError {
    /// Payload was not valid JSON, or JCS canonicalization failed.
    Canonicalize,
    /// Public key was not 32 bytes / not a valid Ed25519 point.
    BadPublicKey,
    /// Signature was not 64 bytes.
    BadSignature,
    /// Signature did not verify against the canonical payload.
    VerifyFailed,
}

/// Canonicalize a JSON payload to its RFC 8785 byte sequence.
pub fn canonicalize(payload_json: &[u8]) -> Result<Vec<u8>, AuthProofError> {
    let value: serde_json::Value =
        serde_json::from_slice(payload_json).map_err(|_| AuthProofError::Canonicalize)?;
    serde_jcs::to_vec(&value).map_err(|_| AuthProofError::Canonicalize)
}

/// Verify an Ed25519 auth proof: signature over `JCS(payload_json)`.
pub fn verify(
    public_key: &[u8],
    payload_json: &[u8],
    signature: &[u8],
) -> Result<(), AuthProofError> {
    let canonical = canonicalize(payload_json)?;

    let key_bytes: [u8; 32] = public_key
        .try_into()
        .map_err(|_| AuthProofError::BadPublicKey)?;
    let vk = VerifyingKey::from_bytes(&key_bytes).map_err(|_| AuthProofError::BadPublicKey)?;

    let sig = Signature::from_slice(signature).map_err(|_| AuthProofError::BadSignature)?;

    vk.verify_strict(&canonical, &sig)
        .map_err(|_| AuthProofError::VerifyFailed)
}
