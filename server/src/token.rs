//! Device token: HMAC-SHA256 over `uid.did.kv`, the whole thing base64url-wrapped.
//!
//! Wire format (ADR-0012):
//!
//! ```text
//! base64url( uid "." did "." kv "." base64url(HMAC-SHA256(secret, uid"."did"."kv)) )
//! ```
//!
//! `kv` (key_version) is covered by the HMAC, so a stolen token cannot have its
//! key_version rewritten. Tokens are always 4 segments; the legacy 3-segment
//! (no-kv) shape is rejected.

use crate::model::KeyVersion;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use hmac::{Hmac, Mac};
use sha2::Sha256;

type HmacSha256 = Hmac<Sha256>;

#[derive(Debug, PartialEq, Eq)]
pub enum TokenError {
    /// Outer base64url failed to decode, or was not valid UTF-8.
    Encoding,
    /// Not exactly 4 dot-separated segments.
    Format,
    /// key_version segment is non-numeric or `< 1`.
    KeyVersion,
    /// Signature segment failed to base64url-decode.
    SignatureEncoding,
    /// HMAC mismatch.
    Signature,
}

/// Generate a device token. `KeyVersion` is ≥ 1 by construction, so there's no
/// `kv < 1` case to clamp — it's unrepresentable.
pub fn generate(secret: &[u8], user_id: &str, device_id: &str, key_version: KeyVersion) -> String {
    let payload = format!("{user_id}.{device_id}.{}", key_version.get());
    let mac = compute_hmac(secret, payload.as_bytes());
    let raw = format!("{payload}.{}", URL_SAFE_NO_PAD.encode(mac));
    URL_SAFE_NO_PAD.encode(raw.as_bytes())
}

/// Decode a 4-segment token and verify its HMAC.
/// Any other shape — including the legacy 3-segment form — is rejected.
pub fn parse(secret: &[u8], token: &str) -> Result<(String, String, KeyVersion), TokenError> {
    let raw = URL_SAFE_NO_PAD
        .decode(token)
        .map_err(|_| TokenError::Encoding)?;
    let raw = String::from_utf8(raw).map_err(|_| TokenError::Encoding)?;

    let parts: Vec<&str> = raw.split('.').collect();
    if parts.len() != 4 {
        return Err(TokenError::Format);
    }
    let (user_id, device_id, kv_str, sig_b64) = (parts[0], parts[1], parts[2], parts[3]);

    // Parse the key_version before decoding the signature. `KeyVersion`
    // rejects 0; `parse::<u32>` rejects negatives and non-numerics.
    let kv = kv_str
        .parse::<u32>()
        .ok()
        .and_then(KeyVersion::new)
        .ok_or(TokenError::KeyVersion)?;

    let sig = URL_SAFE_NO_PAD
        .decode(sig_b64)
        .map_err(|_| TokenError::SignatureEncoding)?;

    // Recompute over the *original* kv segment (`kv_str`), not a re-formatted
    // one: the HMAC covers the segment verbatim. `verify_slice` is constant-time.
    let message = format!("{user_id}.{device_id}.{kv_str}");
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(message.as_bytes());
    mac.verify_slice(&sig).map_err(|_| TokenError::Signature)?;

    Ok((user_id.to_string(), device_id.to_string(), kv))
}

fn compute_hmac(secret: &[u8], message: &[u8]) -> Vec<u8> {
    let mut mac = HmacSha256::new_from_slice(secret).expect("HMAC accepts any key length");
    mac.update(message);
    mac.finalize().into_bytes().to_vec()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::KeyVersion;

    const SECRET: &[u8] = b"test-server-secret";

    /// Build a raw (outer-encoded) token from arbitrary segments, for crafting
    /// malformed inputs the public API would never emit.
    fn encode_segments(parts: &[&str]) -> String {
        URL_SAFE_NO_PAD.encode(parts.join(".").as_bytes())
    }

    #[test]
    fn round_trip() {
        let token = generate(SECRET, "u-alice", "d-1", KeyVersion::new(3).unwrap());
        let (uid, did, kv) = parse(SECRET, &token).unwrap();
        assert_eq!(
            (uid.as_str(), did.as_str(), kv.get()),
            ("u-alice", "d-1", 3)
        );
    }

    #[test]
    fn key_version_zero_rejected_on_parse() {
        // generate() cannot be handed a 0 — KeyVersion is ≥1 by construction — so
        // the only place a 0 can appear is an untrusted token, which parse rejects.
        let token = encode_segments(&["u-alice", "d-1", "0", "c2ln"]);
        assert_eq!(parse(SECRET, &token), Err(TokenError::KeyVersion));
    }

    #[test]
    fn wrong_secret_rejected() {
        let token = generate(SECRET, "u-alice", "d-1", KeyVersion::ONE);
        assert_eq!(parse(b"other-secret", &token), Err(TokenError::Signature));
    }

    #[test]
    fn legacy_three_segment_rejected() {
        // A would-be pre-kv token: uid.did.sig with no key_version.
        let token = encode_segments(&["u-alice", "d-1", "c2ln"]);
        assert_eq!(parse(SECRET, &token), Err(TokenError::Format));
    }

    #[test]
    fn non_numeric_key_version_rejected() {
        let token = encode_segments(&["u-alice", "d-1", "x", "c2ln"]);
        assert_eq!(parse(SECRET, &token), Err(TokenError::KeyVersion));
    }

    #[test]
    fn tampered_payload_rejected() {
        // Keep a valid signature but swap the user id: HMAC no longer matches.
        let valid = generate(SECRET, "u-alice", "d-1", KeyVersion::ONE);
        let raw = String::from_utf8(URL_SAFE_NO_PAD.decode(&valid).unwrap()).unwrap();
        let parts: Vec<&str> = raw.split('.').collect();
        let forged = encode_segments(&["u-mallory", parts[1], parts[2], parts[3]]);
        assert_eq!(parse(SECRET, &forged), Err(TokenError::Signature));
    }

    #[test]
    fn garbage_encoding_rejected() {
        assert_eq!(parse(SECRET, "not*valid*base64"), Err(TokenError::Encoding));
    }
}
