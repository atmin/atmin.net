# Scenarios

Step-by-step walkthroughs of user-facing flows.
Each scenario describes the sequence of client and server actions,
the resulting S3 state, and is used to generate end-to-end tests.

- [First conversation](./first-conversation.md) — registration, key exchange, first message
- [Multi-device](./multi-device.md) — adding a second device, syncing history
- [Profile and contacts](./profile-and-contacts.md) — profile updates, contact management
- [Session rotation](./session-rotation.md) — Megolm session lifecycle
- [Media](./media.md) — encrypted file upload and download
- [Stolen device](./stolen-device.md) — device compromise and token revocation
- [Invalid token](./invalid-token.md) — server rejects token (401), history survives
- [Offline mode](./offline-mode.md) — network unavailability, cached view, reconnect
- [Account recovery](./account-recovery.md) — restoring from backup secret
- [Account deletion](./account-deletion.md) — full account and data removal

## Invariants

- [Invariants](./invariants.md) — properties that must hold under adverse conditions (network faults, retries, restores). Sibling to user-flow scenarios; split into `invariants/` directory when the list grows.
