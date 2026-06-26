# Scenarios

Step-by-step walkthroughs of user-facing flows.
Each scenario describes the sequence of client and server actions,
the resulting S3 state, and is used to generate end-to-end tests.

- [First conversation](./first-conversation.md) — registration, key exchange, first message
- [Custom handles](./custom-handles.md) — user-chosen handle at registration, 30-day cooldown on deletion, /@-prefixed URLs
- [Credential registration](./credential-registration.md) — password + Argon2id registration and login
- [Credential rotation](./credential-rotation.md) — change-password flow with continuity signature + lazy chain
- [Credential multi-device cutoff](./credential-multi-device-cutoff.md) — stale device's reaction to rotation on another device
- [Multi-device](./multi-device.md) — adding a second device, syncing history
- [Profile and contacts](./profile-and-contacts.md) — profile updates, contact management
- [Session rotation](./session-rotation.md) — Megolm session lifecycle
- [Media](./media.md) — encrypted file upload and download
- [Compose tray](./compose.md) — stage an attachment (pick / paste / drop), add a companion message, then explicit send
- [Message amendments](./message-amendments.md) — editing and deleting sent messages via amendment envelopes
- [Unread messages](./unread-messages.md) — unread counts, the `── New ──` divider, app-icon badge, and zero-knowledge cross-device read sync
- [Stolen device](./stolen-device.md) — device compromise and token revocation
- [Invalid token](./invalid-token.md) — server rejects token (401), history survives
- [Offline mode](./offline-mode.md) — network unavailability, cached view, reconnect
- [Account recovery](./account-recovery.md) — restoring from backup secret
- [Account deletion](./account-deletion.md) — full account and data removal

## Invariants

- [Invariants](./invariants/README.md) — properties that must hold under adverse conditions (network faults, retries, restores). Sibling to user-flow scenarios; one file per invariant under [`invariants/`](./invariants/).
