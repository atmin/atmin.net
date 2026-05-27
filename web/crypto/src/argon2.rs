use argon2::{Algorithm, Argon2, Params, Version};
use wasm_bindgen::prelude::*;

/// Stretch a password into a 16-byte secret with Argon2id.
///
/// The output is fed as the `secret` input to the existing HKDF chain
/// (see `crypto.ts` / ADR-0011). `m_kib` is the memory cost in KiB, `t`
/// the iteration count, `p` the parallelism. The salt must be exactly
/// 16 bytes — the per-account salt generated client-side at registration.
///
/// Errors on an invalid parameter combination or a salt of the wrong
/// length, rather than silently producing a weak or mismatched key.
#[wasm_bindgen]
pub fn derive_secret(
    password: &[u8],
    salt: &[u8],
    m_kib: u32,
    t: u32,
    p: u32,
) -> Result<Vec<u8>, JsError> {
    if salt.len() != 16 {
        return Err(JsError::new(&format!(
            "salt must be 16 bytes, got {}",
            salt.len()
        )));
    }

    let params = Params::new(m_kib, t, p, Some(16))
        .map_err(|e| JsError::new(&format!("invalid argon2 params: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut out = vec![0u8; 16];
    argon2
        .hash_password_into(password, salt, &mut out)
        .map_err(|e| JsError::new(&format!("argon2 derivation failed: {e}")))?;
    Ok(out)
}
