# Device revocation and key rotation

v0.1 includes token revocation (see [spec](../specs/mvp-v0.1.md#revoke-device)).
This section covers defense-in-depth measures beyond token revocation.

## Backup secret rotation

Token revocation stops API access, but the attacker still holds cryptographic keys.
If the attacker later regains access (server bug, server compromise), those keys
become dangerous again. Key rotation eliminates this residual risk:

1. **Generate new backup secret** on a surviving device → new auth, sharing, backup keys.
2. **Prove continuity** — sign the new public keys with the old auth key.
   Server verifies both signatures, updates `profile.json`.
3. **Re-encrypt key backups** — decrypt with old backup key, re-encrypt with new one.
   Can be lazy: new sessions use new key immediately, old backups migrate in background.
4. **Contacts pick up new sharing key** — next time they fetch the profile,
   new key shares use the new key. No explicit notification.
5. **Force Megolm session rotation** — surviving devices create new sessions.

**What rotation protects**: all future key shares, key backups, messages, and device additions.

**What's permanently exposed**: messages and keys the attacker already downloaded.
This is unavoidable in any system where keys must be on-device.

Server changes: rotate-keys endpoint, `key_version` in `profile.json`.
All additive — no structural changes.

## App-level key protection (optional hardening)

Local key material can be gated behind:

- **App passphrase** — encrypt IndexedDB keys at rest, require passphrase on app open.
  Protects against casual physical access. UX cost: passphrase entry on every launch.
- **WebAuthn / biometrics** — use platform authenticator to gate key release.
  Better UX than passphrase, but browser support varies.

Neither replaces OS-level device lock, but both add defense-in-depth.
