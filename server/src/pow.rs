//! Registration proof-of-work (ADR-0020).
//!
//! A memory-hard Argon2id cost on `POST /v1/register` so bulk account creation
//! pays scarce RAM per account — no CAPTCHA, no third party, no PII, all
//! in-process. The scheme is a **leading-zero-bits search with Argon2id as the
//! hash**, not a single fixed-work hash: a fixed-work proof would force the
//! server to recompute the full ~30s to verify (a trivial DoS). The search makes
//! verification *one* hash while the client pays ~`2^bits`, so both properties
//! hold at once — defender/attacker asymmetry *and* memory-hardness (every
//! attempt is RAM-bound, ADR-0020 § Proof construction).
//!
//! This PoW derives no key material and is discarded after verification —
//! entirely separate from the credential KDF and its floor (ADR-0011/0016).
//! Disabling it (the `bits == 0` switch) lowers abuse resistance only, never
//! confidentiality.

use argon2::{Algorithm, Argon2, Params, Version};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::RwLock;
use std::time::{Duration, Instant};

// Issued difficulty. Argon2id parameters for a single proof hash; `bits` is the
// leading-zero-bit target the client grinds for. The server pays one hash to
// verify; the client pays ~2^bits. `m` is kept modest so the per-verify
// allocation stays small while each hash is still RAM-bound.
//
// CALIBRATION: expected client work is `2^POW_BITS × single-hash-time`, and the
// geometric tail means some clients pay several× the mean. Measured per-hash for
// this ~19 MiB hash: ~15 ms on a fast desktop (M5 Max), ~450 ms on a low-end
// phone — so `bits = 6` (~64 hashes) lands at ~4 s desktop / ~30 s slow phone,
// matching ADR-0020's "~30 s on a slow device" aim. The phone's high per-hash
// cost confirms the hash is RAM-bound (GPU/ASIC-resistant). Raise `POW_BITS`
// cautiously — each +1 doubles the client wait *and its tail*; `bits` is issued
// in the challenge, so tuning it needs no client rebuild.
const POW_M_KIB: u32 = 19_456; // 19 MiB
const POW_T: u32 = 2;
const POW_P: u32 = 1;
const POW_BITS: u32 = 6;
const POW_OUTPUT_LEN: usize = 32;

/// How long an issued challenge nonce stays usable. Single-use within this
/// window; in-process now, shared-state later (same pattern as `cache.rs`).
pub const POW_NONCE_TTL: Duration = Duration::from_secs(300);

/// The issued PoW difficulty, held on [`crate::config::ServerConfig`].
/// `bits == 0` disables the PoW: any proof passes (the test/e2e switch).
#[derive(Debug, Clone, Copy)]
pub struct PowConfig {
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub bits: u32,
}

impl PowConfig {
    /// Production difficulty.
    pub fn enabled() -> PowConfig {
        PowConfig {
            m: POW_M_KIB,
            t: POW_T,
            p: POW_P,
            bits: POW_BITS,
        }
    }

    /// Disabled (`bits == 0`) — any proof passes. `m`/`t`/`p` stay valid so the
    /// challenge it issues is still well-formed. Test/e2e only (ADR-0020).
    pub fn disabled() -> PowConfig {
        PowConfig {
            bits: 0,
            ..PowConfig::enabled()
        }
    }
}

/// Issued to the client by `GET /v1/register/challenge`.
#[derive(Debug, Serialize)]
pub struct PowChallenge {
    /// 16 random bytes, base64url (no pad). Single-use; the client also uses it
    /// as the Argon2 salt, binding the proof to this challenge.
    pub nonce: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
    pub bits: u32,
}

/// Submitted with `POST /v1/register`.
#[derive(Debug, Default, Deserialize)]
pub struct PowProof {
    #[serde(default)]
    pub nonce: String,
    #[serde(default)]
    pub counter: u64,
}

/// Single-use challenge nonces with a short TTL — in-process ephemeral state,
/// mirroring [`crate::cache`]. `Instant`-based aging (monotonic).
pub struct PowNonceStore {
    ttl: Duration,
    nonces: RwLock<HashMap<String, Instant>>,
}

impl PowNonceStore {
    pub fn new() -> PowNonceStore {
        PowNonceStore::with_ttl(POW_NONCE_TTL)
    }

    /// Construct with a custom TTL (tests use `Duration::ZERO` to force staleness).
    pub fn with_ttl(ttl: Duration) -> PowNonceStore {
        PowNonceStore {
            ttl,
            nonces: RwLock::new(HashMap::new()),
        }
    }

    /// Record a freshly issued nonce. Prunes expired entries opportunistically so
    /// the map stays bounded without a background task.
    pub fn issue(&self, nonce: &str) {
        let mut g = self.nonces.write().unwrap();
        g.retain(|_, at| at.elapsed() < self.ttl);
        g.insert(nonce.to_string(), Instant::now());
    }

    /// Remove `nonce`; returns true iff it was present and unexpired. Single-use:
    /// a second consume of the same nonce returns false.
    pub fn consume(&self, nonce: &str) -> bool {
        match self.nonces.write().unwrap().remove(nonce) {
            Some(at) => at.elapsed() < self.ttl,
            None => false,
        }
    }
}

impl Default for PowNonceStore {
    fn default() -> PowNonceStore {
        PowNonceStore::new()
    }
}

/// Mint a fresh challenge at the configured difficulty and record its nonce.
pub fn new_challenge(cfg: &PowConfig, store: &PowNonceStore) -> PowChallenge {
    let nonce = URL_SAFE_NO_PAD.encode(ulid::Ulid::new().to_bytes());
    store.issue(&nonce);
    PowChallenge {
        nonce,
        m: cfg.m,
        t: cfg.t,
        p: cfg.p,
        bits: cfg.bits,
    }
}

/// Verify a proof against the issued difficulty. The caller must already have
/// consumed the nonce (single-use); this only checks the hash target. `bits == 0`
/// (disabled) accepts unconditionally.
pub fn verify(proof: &PowProof, cfg: &PowConfig) -> bool {
    if cfg.bits == 0 {
        return true;
    }
    let Ok(nonce) = URL_SAFE_NO_PAD.decode(&proof.nonce) else {
        return false;
    };
    if nonce.len() != 16 {
        return false;
    }
    let Some(out) = hash(proof.counter, &nonce, cfg) else {
        return false;
    };
    leading_zero_bits(&out) >= cfg.bits
}

/// One Argon2id hash: password is the counter (LE), salt is the nonce.
fn hash(counter: u64, nonce: &[u8], cfg: &PowConfig) -> Option<[u8; POW_OUTPUT_LEN]> {
    let params = Params::new(cfg.m, cfg.t, cfg.p, Some(POW_OUTPUT_LEN)).ok()?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; POW_OUTPUT_LEN];
    argon2
        .hash_password_into(&counter.to_le_bytes(), nonce, &mut out)
        .ok()?;
    Some(out)
}

/// Count of leading zero bits across the byte string (big-endian).
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

    /// Tiny params so the search is fast — unit tests must not pay 19 MiB hashes.
    fn tiny() -> PowConfig {
        PowConfig {
            m: 64,
            t: 1,
            p: 1,
            bits: 4,
        }
    }

    #[test]
    fn leading_zero_bits_counts_correctly() {
        assert_eq!(leading_zero_bits(&[0xff]), 0);
        assert_eq!(leading_zero_bits(&[0x0f]), 4);
        assert_eq!(leading_zero_bits(&[0x00, 0xff]), 8);
        assert_eq!(leading_zero_bits(&[0x00, 0x01]), 15);
        assert_eq!(leading_zero_bits(&[0x00, 0x00]), 16);
    }

    #[test]
    fn nonce_store_is_single_use() {
        let s = PowNonceStore::new();
        s.issue("abc");
        assert!(s.consume("abc")); // first use
        assert!(!s.consume("abc")); // single-use: gone
        assert!(!s.consume("never-issued")); // unknown
    }

    #[test]
    fn nonce_store_expires() {
        let s = PowNonceStore::with_ttl(Duration::ZERO);
        s.issue("abc");
        assert!(!s.consume("abc")); // any elapsed time is already stale
    }

    #[test]
    fn verify_accepts_a_real_proof_and_rejects_a_wrong_one() {
        let cfg = tiny();
        let nonce_bytes = [7u8; 16];
        let nonce = URL_SAFE_NO_PAD.encode(nonce_bytes);

        // Grind a counter meeting the target, exactly as the client would.
        let mut counter = 0u64;
        loop {
            let out = hash(counter, &nonce_bytes, &cfg).unwrap();
            if leading_zero_bits(&out) >= cfg.bits {
                break;
            }
            counter += 1;
        }

        let good = PowProof {
            nonce: nonce.clone(),
            counter,
        };
        assert!(verify(&good, &cfg));

        // A counter that does not meet the target is rejected. Find one.
        let mut bad_counter = counter + 1;
        while leading_zero_bits(&hash(bad_counter, &nonce_bytes, &cfg).unwrap()) >= cfg.bits {
            bad_counter += 1;
        }
        let bad = PowProof {
            nonce,
            counter: bad_counter,
        };
        assert!(!verify(&bad, &cfg));
    }

    #[test]
    fn verify_rejects_malformed_nonce_when_enabled() {
        let cfg = tiny();
        assert!(!verify(
            &PowProof {
                nonce: String::new(),
                counter: 0
            },
            &cfg
        ));
        assert!(!verify(
            &PowProof {
                nonce: "not base64!!".into(),
                counter: 0
            },
            &cfg
        ));
        // Valid base64url but wrong length (8 bytes, not 16).
        assert!(!verify(
            &PowProof {
                nonce: URL_SAFE_NO_PAD.encode([0u8; 8]),
                counter: 0
            },
            &cfg
        ));
    }

    #[test]
    fn disabled_accepts_anything() {
        let cfg = PowConfig::disabled();
        assert_eq!(cfg.bits, 0);
        // Even an empty proof passes once disabled (the nonce check is the
        // caller's; verify only judges the hash target).
        assert!(verify(&PowProof::default(), &cfg));
    }
}
