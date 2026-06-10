//! Domain newtypes: making illegal states unrepresentable.
//!
//! The opening move of phase 2 (ADR-0018). Invariants the Go server enforces at
//! runtime move into the type system, so the compiler — not a defensive check —
//! rules out the bad state.

use std::num::NonZeroU32;

/// A `key_version` (ADR-0012): ≥ 1 by construction. There is no `KeyVersion(0)`,
/// so the Go server's "clamp `kv < 1` to 1" step is simply unnecessary here — a
/// caller cannot express the bad value in the first place.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub struct KeyVersion(NonZeroU32);

impl KeyVersion {
    /// `key_version` 1 — the version every account starts at.
    pub const ONE: KeyVersion = KeyVersion(NonZeroU32::MIN);

    /// Construct from a raw integer. `None` for 0 — the one illegal value.
    pub fn new(v: u32) -> Option<KeyVersion> {
        NonZeroU32::new(v).map(KeyVersion)
    }

    /// The underlying value, always ≥ 1.
    pub fn get(self) -> u32 {
        self.0.get()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_is_not_a_key_version() {
        assert_eq!(KeyVersion::new(0), None);
    }

    #[test]
    fn positive_round_trips() {
        assert_eq!(KeyVersion::new(3).unwrap().get(), 3);
        assert_eq!(KeyVersion::ONE.get(), 1);
    }
}
