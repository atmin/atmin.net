//! Ed25519 auth proof over the JCS-canonical (RFC 8785) bytes of the payload.
//!
//! The payload `{user_id, device_id, timestamp, key_version}` is canonicalized
//! with JCS and signed with the account's auth key. The signer is the TS client
//! (`web/src/lib/crypto.ts`, the `canonicalize` package), so the canonical bytes
//! produced here (`serde_jcs`) must match the client's byte-for-byte — see the
//! interop battery in `tests/interop.rs`.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use chrono::{DateTime, Utc};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::Deserialize;
use serde_json::value::RawValue;

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

/// Max age of an auth proof's timestamp (the ±5-minute freshness window, auth.go).
pub const AUTH_PROOF_MAX_AGE_SECS: i64 = 300;

/// A signed auth proof as sent on the wire: a `payload` object plus a base64url
/// Ed25519 `signature` over its JCS-canonical bytes. The payload is kept as a
/// `RawValue` so it can be canonicalized exactly as received, before any
/// re-serialization could perturb the bytes.
#[derive(Deserialize)]
pub struct AuthProof {
    pub payload: Box<RawValue>,
    pub signature: String,
}

/// The typed payload inside an [`AuthProof`].
#[derive(Deserialize)]
pub struct AuthProofPayload {
    pub user_id: String,
    pub device_id: String,
    pub timestamp: String,
    #[serde(default)]
    pub key_version: u32,
}

/// Verify a proof's signature (over JCS(payload)), its freshness (±5 min from
/// `now`), and that it carries `key_version >= 1`.
/// Does *not* check key_version against the account's current value — the caller
/// does that, since it needs the profile. Returns the parsed payload on success.
pub fn verify_proof(
    public_key: &[u8],
    proof: &AuthProof,
    now: DateTime<Utc>,
) -> Result<AuthProofPayload, AuthProofError> {
    let sig = URL_SAFE_NO_PAD
        .decode(&proof.signature)
        .map_err(|_| AuthProofError::BadSignature)?;
    verify(public_key, proof.payload.get().as_bytes(), &sig)?;

    let payload: AuthProofPayload =
        serde_json::from_str(proof.payload.get()).map_err(|_| AuthProofError::Canonicalize)?;

    let ts = DateTime::parse_from_rfc3339(&payload.timestamp)
        .map_err(|_| AuthProofError::VerifyFailed)?
        .with_timezone(&Utc);
    if (now - ts).num_seconds().abs() > AUTH_PROOF_MAX_AGE_SECS {
        return Err(AuthProofError::VerifyFailed);
    }
    if payload.key_version == 0 {
        return Err(AuthProofError::VerifyFailed);
    }
    Ok(payload)
}
