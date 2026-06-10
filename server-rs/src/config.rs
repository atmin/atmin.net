//! Server configuration, held as Rocket-managed state. Mirrors the auth-relevant
//! slice of `server/config.go`; grows as handlers need more (S3 creds, etc.).

/// Configuration available to guards and handlers.
pub struct ServerConfig {
    /// HMAC secret for device tokens (`token::generate` / `token::parse`).
    pub server_secret: Vec<u8>,
}
