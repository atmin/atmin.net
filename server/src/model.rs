//! Domain newtypes: making illegal states unrepresentable.
//!
//! Invariants that would otherwise be enforced by runtime checks live in the type
//! system instead, so the compiler — not a defensive check — rules out the bad
//! state.

use std::num::NonZeroU32;

/// A `key_version` (ADR-0012): ≥ 1 by construction. There is no `KeyVersion(0)`,
/// so no clamp-to-1 step is needed — a caller cannot express the bad value in the
/// first place.
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

/// Error constructing a [`UserId`] / [`DeviceId`].
#[derive(Debug, PartialEq, Eq)]
pub enum IdError {
    /// Not a canonical 26-char Crockford-base32 ULID.
    NotUlid,
}

/// Crockford base32 alphabet (the ULID encoding): digits + uppercase letters,
/// excluding I, L, O, U. ULIDs are emitted uppercase.
const CROCKFORD: &[u8] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

fn validate_ulid(s: &str) -> Result<(), IdError> {
    let b = s.as_bytes();
    // Canonical ULID: exactly 26 Crockford-base32 characters.
    if b.len() != 26 || !b.iter().all(|c| CROCKFORD.contains(c)) {
        return Err(IdError::NotUlid);
    }
    // The first character carries the top bits of the 48-bit timestamp, so a
    // valid ULID never exceeds '7' there (anything higher overflows 48 bits).
    if b[0] > b'7' {
        return Err(IdError::NotUlid);
    }
    Ok(())
}

/// A user id: a ULID (spec mvp-v0.1 "IDs & naming"). Validated on construction.
///
/// Enforcing the ULID shape here — rather than trusting the client-supplied
/// `user_id` — guarantees the value is safe in the dotted token format and as an
/// S3 key segment (a ULID contains no `.` or `/`).
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct UserId(String);

impl UserId {
    pub fn new(s: impl Into<String>) -> Result<UserId, IdError> {
        let s = s.into();
        validate_ulid(&s)?;
        Ok(UserId(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// A device id: a ULID, same rules as [`UserId`].
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct DeviceId(String);

impl DeviceId {
    pub fn new(s: impl Into<String>) -> Result<DeviceId, IdError> {
        let s = s.into();
        validate_ulid(&s)?;
        Ok(DeviceId(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Error constructing a [`Handle`] — *syntax* only. The reserved-list policy is
/// deliberately not a type concern: it is config-dependent and yields a distinct
/// `handle_reserved` error, so the registration handler checks it separately
/// (ADR-0013).
#[derive(Debug, PartialEq, Eq)]
pub enum HandleError {
    Invalid,
}

/// A user handle (ADR-0013): `^[a-z][a-z0-9-]{1,30}[a-z0-9]$` with no consecutive
/// hyphens. Stored bare — the `@` prefix is UI-only. Syntax is enforced here;
/// reserved-list membership is a separate policy check at the handler.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Handle(String);

impl Handle {
    pub fn new(s: impl Into<String>) -> Result<Handle, HandleError> {
        let s = s.into();
        validate_handle_syntax(&s)?;
        Ok(Handle(s))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn validate_handle_syntax(s: &str) -> Result<(), HandleError> {
    let b = s.as_bytes();
    let n = b.len();
    if !(3..=32).contains(&n) {
        return Err(HandleError::Invalid);
    }
    // First char a lowercase letter; last char a lowercase letter or digit (never
    // a hyphen); body is [a-z0-9-]. "No consecutive hyphens" can't be expressed in
    // a single character-class regex, so it's checked separately below.
    if !b[0].is_ascii_lowercase() {
        return Err(HandleError::Invalid);
    }
    let last = b[n - 1];
    if !(last.is_ascii_lowercase() || last.is_ascii_digit()) {
        return Err(HandleError::Invalid);
    }
    if !b
        .iter()
        .all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(HandleError::Invalid);
    }
    if s.contains("--") {
        return Err(HandleError::Invalid);
    }
    Ok(())
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

    const ULID: &str = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

    #[test]
    fn ids_accept_a_valid_ulid() {
        assert_eq!(UserId::new(ULID).unwrap().as_str(), ULID);
        assert_eq!(DeviceId::new(ULID).unwrap().as_str(), ULID);
    }

    #[test]
    fn ids_reject_non_ulid() {
        for bad in [
            "",                           // empty
            "01ARZ3NDEKTSV4RRFFQ69G5FA",  // 25 chars
            "01arz3ndektsv4rrffq69g5fav", // lowercase (canonical is uppercase)
            "01ARZ3NDEKTSV4RRFFQ69G5FAI", // 'I' is excluded from Crockford base32
            "01ARZ3NDEKTSV4RRFFQ69G5FA.", // '.' would break the dotted token format
            "01ARZ3NDEKTSV4RRFFQ69G5FA/", // '/' would break the S3 key path
            "81ARZ3NDEKTSV4RRFFQ69G5FAV", // first char > '7' overflows the timestamp
        ] {
            assert_eq!(
                UserId::new(bad),
                Err(IdError::NotUlid),
                "should reject {bad:?}"
            );
            assert_eq!(
                DeviceId::new(bad),
                Err(IdError::NotUlid),
                "should reject {bad:?}"
            );
        }
    }

    #[test]
    fn handle_accepts_valid() {
        for ok in ["abc", "copper-falcon", "a1b2c3", "ab1"] {
            assert!(Handle::new(ok).is_ok(), "should accept {ok:?}");
        }
    }

    #[test]
    fn handle_rejects_invalid_syntax() {
        for bad in [
            "ab",       // too short (< 3)
            "1abc",     // leading digit
            "abc-",     // trailing hyphen
            "Abc",      // uppercase
            "foo--bar", // consecutive hyphens
            "a_b",      // underscore not allowed
            "a.b",      // dot not allowed
            "café",     // non-ASCII
        ] {
            assert_eq!(
                Handle::new(bad),
                Err(HandleError::Invalid),
                "should reject {bad:?}"
            );
        }
        assert_eq!(Handle::new("a".repeat(33)), Err(HandleError::Invalid)); // too long
    }

    #[test]
    fn handle_does_not_enforce_reserved_list() {
        // "admin" is reserved by policy but syntactically valid — the type accepts
        // it; the reserved-list check is the handler's job (ADR-0013).
        assert!(Handle::new("admin").is_ok());
    }
}
