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

/// Solve a registration proof-of-work (ADR-0020): find the smallest `counter`
/// whose `Argon2id(counter_le, salt = nonce)` output has at least `bits` leading
/// zero bits, at the server-issued difficulty.
///
/// Memory-hard search — each attempt is RAM-bound, so a GPU/ASIC gains little.
/// The loop runs in WASM (not JS) to avoid a boundary crossing per attempt.
/// `bits == 0` (the disabled switch) returns 0 immediately. Returns the counter
/// as `f64` — it stays well under 2^53, and an `f64`/JS number is JSON-friendly
/// (a `u64`/BigInt is not).
#[wasm_bindgen]
pub fn solve_pow(nonce: &[u8], m_kib: u32, t: u32, p: u32, bits: u32) -> Result<f64, JsError> {
    if bits == 0 {
        return Ok(0.0);
    }
    let params = Params::new(m_kib, t, p, Some(32))
        .map_err(|e| JsError::new(&format!("invalid argon2 params: {e}")))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut out = [0u8; 32];
    let mut counter: u64 = 0;
    loop {
        argon2
            .hash_password_into(&counter.to_le_bytes(), nonce, &mut out)
            .map_err(|e| JsError::new(&format!("argon2 pow failed: {e}")))?;
        if leading_zero_bits(&out) >= bits {
            return Ok(counter as f64);
        }
        counter += 1;
    }
}

/// Count of leading zero bits across the byte string (big-endian). Must match the
/// server's verifier (`server/src/pow.rs`).
fn leading_zero_bits(bytes: &[u8]) -> u32 {
    let mut count = 0;
    for &b in bytes {
        if b == 0 {
            count += 8;
        } else {
            count += b.leading_zeros();
            break;
        }
    }
    count
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn leading_zero_bits_counts_correctly() {
        assert_eq!(leading_zero_bits(&[0xff]), 0);
        assert_eq!(leading_zero_bits(&[0x0f]), 4);
        assert_eq!(leading_zero_bits(&[0x00, 0x80]), 8);
        assert_eq!(leading_zero_bits(&[0x00, 0x00]), 16);
    }

    #[test]
    fn solve_pow_finds_a_counter_meeting_the_target() {
        // Tiny params + small target so the test is fast.
        let nonce = [3u8; 16];
        let bits = 8;
        let counter = solve_pow(&nonce, 64, 1, 1, bits).unwrap() as u64;

        // Recompute and confirm the solution actually meets the target.
        let params = Params::new(64, 1, 1, Some(32)).unwrap();
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut out = [0u8; 32];
        argon2
            .hash_password_into(&counter.to_le_bytes(), &nonce, &mut out)
            .unwrap();
        assert!(leading_zero_bits(&out) >= bits);
    }

    #[test]
    fn solve_pow_zero_bits_is_trivial() {
        assert_eq!(solve_pow(&[0u8; 16], 64, 1, 1, 0).unwrap(), 0.0);
    }
}
