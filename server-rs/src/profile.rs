//! Profile / handle data types. Mirrors `server/profile.go`.

use serde::{Deserialize, Serialize};

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
/// *tombstone* (only `released_at`). Field presence mirrors Go's `omitempty` so
/// the wire shape is byte-identical; `salt`/`kdf`/`key_version` are always
/// present (null/0/"" on a tombstone).
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
/// of truth. Mirrors `server/profile.go`. The container `#[serde(default)]`
/// matches Go's `json.Unmarshal` tolerance: absent fields become the zero value
/// rather than a parse error.
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
