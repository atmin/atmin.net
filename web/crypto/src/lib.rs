use wasm_bindgen::prelude::*;
use vodozemac::megolm::{
    GroupSession, InboundGroupSession, SessionConfig,
};

/// Megolm sending session. Creates encrypted messages.
#[wasm_bindgen]
pub struct MegolmOutbound {
    inner: GroupSession,
}

#[wasm_bindgen]
impl MegolmOutbound {
    /// Create a new sending session.
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: GroupSession::new(SessionConfig::version_2()),
        }
    }

    /// Session ID (used as key in key backup).
    #[wasm_bindgen(getter)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    /// Current message index.
    #[wasm_bindgen(getter)]
    pub fn message_index(&self) -> u32 {
        self.inner.message_index()
    }

    /// Export the session key (for sharing with recipients).
    /// Returns base64-encoded session key.
    pub fn session_key(&self) -> String {
        self.inner.session_key().to_base64()
    }

    /// Encrypt a plaintext message. Returns base64-encoded ciphertext.
    pub fn encrypt(&mut self, plaintext: &str) -> String {
        let msg = self.inner.encrypt(plaintext);
        msg.to_base64()
    }
}

/// Megolm receiving session. Decrypts messages from a specific sender session.
#[wasm_bindgen]
pub struct MegolmInbound {
    inner: InboundGroupSession,
}

#[wasm_bindgen]
impl MegolmInbound {
    /// Create from an authenticated session key (direct from sender).
    /// Takes base64-encoded session key.
    pub fn from_session_key(session_key_b64: &str) -> Result<MegolmInbound, JsError> {
        let key = vodozemac::megolm::SessionKey::from_base64(session_key_b64)
            .map_err(|e| JsError::new(&format!("invalid session key: {e}")))?;
        let session = InboundGroupSession::new(&key, SessionConfig::version_2());
        Ok(Self { inner: session })
    }

    /// Create from an exported session key (from key backup).
    /// Takes base64-encoded exported session key.
    pub fn from_export(exported_b64: &str) -> Result<MegolmInbound, JsError> {
        let key = vodozemac::megolm::ExportedSessionKey::from_base64(exported_b64)
            .map_err(|e| JsError::new(&format!("invalid exported key: {e}")))?;
        let session = InboundGroupSession::import(&key, SessionConfig::version_2());
        Ok(Self { inner: session })
    }

    /// Session ID.
    #[wasm_bindgen(getter)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    /// Earliest message index this session can decrypt.
    #[wasm_bindgen(getter)]
    pub fn first_known_index(&self) -> u32 {
        self.inner.first_known_index()
    }

    /// Decrypt a message. Takes base64-encoded ciphertext.
    /// Returns the decrypted plaintext.
    pub fn decrypt(&mut self, ciphertext_b64: &str) -> Result<String, JsError> {
        let msg = vodozemac::megolm::MegolmMessage::from_base64(ciphertext_b64)
            .map_err(|e| JsError::new(&format!("invalid ciphertext: {e}")))?;
        let result = self.inner.decrypt(&msg)
            .map_err(|e| JsError::new(&format!("decryption failed: {e}")))?;
        String::from_utf8(result.plaintext)
            .map_err(|e| JsError::new(&format!("invalid utf8: {e}")))
    }

    /// Export session at first known index (for key backup).
    /// Returns base64-encoded exported session key.
    pub fn export_at_first_known_index(&self) -> String {
        self.inner.export_at_first_known_index().to_base64()
    }
}
