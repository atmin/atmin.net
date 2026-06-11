//! Server configuration, held as Rocket-managed state.
//!
//! Config is split by audience: handlers/guards only ever read the HMAC secret,
//! so [`ServerConfig`] carries just that. The S3 credentials live in
//! [`S3Config`], consumed once by `main.rs` to build the store and never seen by a
//! handler — the store encapsulates them.

/// Configuration available to guards and handlers.
pub struct ServerConfig {
    /// HMAC secret for device tokens (`token::generate` / `token::parse`).
    pub server_secret: Vec<u8>,
}

/// S3 connection settings, loaded from the `S3_*` environment variables.
pub struct S3Config {
    pub endpoint: String,
    /// Browser-reachable endpoint for presigned URLs (`S3_PUBLIC_ENDPOINT`);
    /// defaults to `endpoint` when unset.
    pub public_endpoint: String,
    pub bucket: String,
    pub region: String,
    pub access_key: String,
    pub secret_key: String,
}

impl S3Config {
    /// Load from the environment. Returns
    /// `None` when `S3_ENDPOINT` is unset — the signal `main.rs` uses to fall back
    /// to the in-memory store for a no-MinIO dev run. When `S3_ENDPOINT` *is* set,
    /// the remaining required vars must be present (else `Err`), so a half-configured
    /// environment fails loudly rather than silently dropping to MemStore.
    pub fn from_env() -> Result<Option<S3Config>, String> {
        let Some(endpoint) = env_opt("S3_ENDPOINT") else {
            return Ok(None);
        };
        Ok(Some(S3Config {
            public_endpoint: env_opt("S3_PUBLIC_ENDPOINT").unwrap_or_else(|| endpoint.clone()),
            bucket: env_required("S3_BUCKET")?,
            region: env_opt("S3_REGION").unwrap_or_else(|| "auto".into()),
            access_key: env_required("S3_ACCESS_KEY")?,
            secret_key: env_required("S3_SECRET_KEY")?,
            endpoint,
        }))
    }
}

fn env_opt(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

fn env_required(key: &str) -> Result<String, String> {
    env_opt(key).ok_or_else(|| format!("required environment variable {key} is not set"))
}
