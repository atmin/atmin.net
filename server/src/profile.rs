//! Profile / handle data types.

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde::{Deserialize, Serialize};

// Server-enforced Argon2id KDF floor/ceiling (ADR-0016). Floor stops weak
// client params; ceiling is a client self-DoS guard.
const KDF_FLOOR_MEMORY_KIB: u32 = 65_536; // 64 MiB
const KDF_MAX_MEMORY_KIB: u32 = 1_048_576; // 1 GiB
const KDF_FLOOR_ITERATIONS: u32 = 3;
const KDF_MAX_ITERATIONS: u32 = 16;
const KDF_MAX_PARALLELISM: u32 = 8;

/// Whether `salt` + `kdf` are an acceptable credential pair: `argon2id`, params
/// within the ADR-0016 floor/ceiling, and a salt that base64url-decodes to
/// exactly 16 bytes.
pub fn valid_kdf_params(salt: &str, kdf: &KdfParams) -> bool {
    if kdf.kind != "argon2id" {
        return false;
    }
    if !(KDF_FLOOR_MEMORY_KIB..=KDF_MAX_MEMORY_KIB).contains(&kdf.m) {
        return false;
    }
    if !(KDF_FLOOR_ITERATIONS..=KDF_MAX_ITERATIONS).contains(&kdf.t) {
        return false;
    }
    if !(1..=KDF_MAX_PARALLELISM).contains(&kdf.p) {
        return false;
    }
    matches!(URL_SAFE_NO_PAD.decode(salt), Ok(b) if b.len() == 16)
}

/// Argon2id stretching parameters (ADR-0011), stored on the profile and surfaced
/// via resolve so a returning device can re-derive keys from its password.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    #[serde(rename = "type")]
    pub kind: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
}

/// The public projection written to `handles/{handle}.json` and returned by
/// resolve. Two shapes share the path: a *live* projection (fields set) or a
/// *tombstone* (only `released_at`). Optional string fields are omitted when
/// empty (`skip_serializing_if`) to pin the wire shape; `salt`/`kdf`/`key_version`
/// are always present (null/0/"" on a tombstone).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct PublicHandleData {
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub user_id: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub sharing_public_key: String,
    #[serde(default)]
    pub salt: String,
    #[serde(default)]
    pub kdf: Option<KdfParams>,
    #[serde(default)]
    pub key_version: u32,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub display_name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub avatar_url: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub released_at: String,
}

/// A user's full profile (`users/{uid}/profile.json`) — the server-owned source
/// of truth. The container `#[serde(default)]` makes decoding tolerant: absent
/// fields become the zero value rather than a parse error.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default)]
pub struct Profile {
    pub user_id: String,
    pub handle: String,
    pub auth_public_key: String,
    pub sharing_public_key: String,
    pub salt: String,
    pub kdf: Option<KdfParams>,
    pub key_version: u32,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub display_name: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub avatar_url: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    pub last_active: String,
    pub created_at: String,
}
