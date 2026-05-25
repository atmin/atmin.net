# Device revocation and key rotation

v0.1 includes token revocation (see [spec](../specs/mvp-v0.1.md#revoke-device))
and credential rotation (see [Backup secret](../specs/mvp-v0.1.md#backup-secret),
[Rotate keys](../specs/mvp-v0.1.md#rotate-keys),
[ADR-0011](../decisions/adr-0011-credential-derivation.md),
[ADR-0012](../decisions/adr-0012-backup-secret-rotation.md)). This
section now covers defense-in-depth measures beyond what is already
specified.

## App-level key protection (optional hardening)

Local key material can be gated behind:

- **App passphrase** — encrypt IndexedDB keys at rest, require passphrase on app open.
  Protects against casual physical access. UX cost: passphrase entry on every launch.
- **WebAuthn / biometrics** — use platform authenticator to gate key release.
  Better UX than passphrase, but browser support varies.

Neither replaces OS-level device lock, but both add defense-in-depth.

Note that the v2 credential (ADR-0011) is a user-typed password run
through Argon2id, not a device-resident secret. The above hardening
protects the **derived** keys cached on the device (sharing private
key, current backup key) — not the credential itself, which is
already off-device.
