# Tasks

Active implementation tasks in priority order. Delete a file once its change lands.

## Credential overhaul (highest priority)

Replaces the BIP39-mnemonic credential with a user-chosen password
stretched through Argon2id, and lifts backup-secret rotation out of
deferred-status into a real "change my password" feature. Removes
the two biggest WTF moments in the current onboarding (12-word
phrase, "what's my recovery again?"). See
[ADR-0011](../docs/decisions/adr-0011-credential-derivation.md) and
[ADR-0012](../docs/decisions/adr-0012-backup-secret-rotation.md)
for the design. The legacy BIP39 mnemonic code paths kept through
the series as a migration-rehearsal vehicle (v1 token / auth-proof
shapes, the autodetect login helper, the missing-`v` envelope
fallback) were removed once every account had migrated — the
single-path codebase is the steady state.

1. **[credential-registration](credential-registration.md)** — Password + confirm + zxcvbn-ts strength meter at registration, Argon2id derivation in a Web Worker, salt + KDF params on `profile.json`. Login screen accepts password or (legacy) mnemonic via autodetect. No rotation yet. Independent of task 2.

2. **[credential-rotate-endpoint](credential-rotate-endpoint.md)** — Server-only `POST /v1/rotate-keys` with JCS-canonicalized continuity signature, per-`user_id` in-server mutex (the backend doesn't support conditional writes — see [ops.md](../docs/ops.md#object-storage-constraints)), idempotency-token retry dedup, token v2 format with `key_version` segment, auth-proof v2 format, new error codes. No UI in this task. Independent of task 1.

3. **[credential-backup-chain](credential-backup-chain.md)** — `keys/{uid}/key_chain.json` of historical backup keys, `{v, iv, ciphertext}` envelope on key-backup blobs and `contacts.json`, in-IDB memoization. Depends on task 2 (for the `key_version` concept).

4. **[credential-rotate-ui](credential-rotate-ui.md)** — Settings → "Change password" panel that orchestrates current-password re-derivation, new-credential derivation, chain-write, continuity-signed `rotateKeys` call. Depends on tasks 1, 2, 3.

5. **[credential-multi-device-cutoff](credential-multi-device-cutoff.md)** — Client reaction to `401 key_version_stale`: clear local state, route to `/login`, show "rotated on another device" notice. Depends on task 2.

## User-chosen handles

Replaces the auto-generated BIP39 handle (`copper-falcon`) with a
user-typed handle that meets DNS-LDH-style charset rules. Pairs
with the credential-overhaul series: the BIP39 mnemonic is going
away there, BIP39 handle is going away here. Both are the
remaining WTF moments in onboarding. See
[ADR-0013](../docs/decisions/adr-0013-user-chosen-handles.md) for
the design.

6. **[custom-handles](custom-handles.md)** — User-typed handle at registration with charset/length validation, reserved-list check, atomic claim via per-handle in-server mutex (same backend constraint as task 2 — see [ops.md](../docs/ops.md#object-storage-constraints)), 30-day cooldown after account deletion, `/@{handle}` URL prefix for PWA routes, "Surprise me" client-side BIP39 button. Adds a small cleanup-routine sweep to GC expired tombstones — that part depends on the cleanup-routine task below.

## Message amendments (edit + delete)

Adds the two most-requested messenger affordances (edit and
delete) via a single primitive: an "amendment envelope" referring
to a prior `msg_id`. Soft delete by design (inbox archives are
append-only; we can't modify what recipients have already
synced), hard delete for the underlying media blob since it lives
in its own S3 object. See
[ADR-0014](../docs/decisions/adr-0014-message-amendments.md) for
the design.

7. **[message-amendments](message-amendments.md)** — New inner-plaintext `type: 'amendment'` carrying `target_msg_id` + `action: edit|delete` + optional `body`. Two-pass materializer applies the chain at chat-view assembly time. "(edited)" tag with timestamp delta; "[deleted]" placeholder preserves reply context. Media delete also fires `DELETE /v1/store/object`. No protocol changes server-side beyond reusing the existing inbox + media-delete endpoints. Independent of all other open tasks.

## Background delivery (push notifications)

Closes the biggest UX gap in the current product: when the app
isn't open, nothing arrives. Web Push fixes that with a
server-built generic notification ("New message from {handle}",
no preview), home-screen badge, and a settings toggle to enable
per-device. Service worker stays free of Megolm keys and the
WASM crypto module by design. See
[ADR-0015](../docs/decisions/adr-0015-web-push.md).

8. **[push-notifications](push-notifications.md)** — VAPID-keyed Web Push, subscription stored as a field on `users/{uid}/devices/{did}.json` (no new prefix), best-effort fan-out on `/v1/send`, custom service worker (VitePWA `injectManifest`) with `push` + `notificationclick` + `pushsubscriptionchange` handlers, local badge counter, settings toggle. iOS users need [ios-install-hint](ios-install-hint.md) (task 11) landed first to receive push at all; everywhere else it ships independently.

## Other active tasks

9. **[server-cleanup-routine](server-cleanup-routine.md)** — Automated S3 cleanup for inactive and abandoned accounts plus expired handle tombstones (new sweep target added by custom-handles). The `last_active` tracking prerequisite is already in place; this is the production-health item most at risk of being deferred indefinitely.

10. **[account-deletion-ui](account-deletion-ui.md)** — Settings → Danger zone panel that wires `DELETE /v1/profile` (already implemented + tested server-side) to a user-facing flow. Password is re-derived against `profile.auth_public_key` as a cryptographic gate (same pattern as change-password), plus typed-handle confirmation + acknowledgement checkbox before the destructive call. Covers the 30-day handle cooldown surfacing and the multi-device-sign-out propagation. Closes the GDPR-baseline gap of "user cannot leave without operator help."

11. **[ios-install-hint](ios-install-hint.md)** — Dismissible banner on iOS Safari pointing users toward "Add to Home Screen." Low effort; iOS has no native install prompt so without this the PWA is effectively undiscoverable on the platform. Prerequisite for push notifications (task 8) to work on iOS.

12. **[draft-persist](draft-persist.md)** — Persist unsent message drafts to localStorage across reloads. Small and self-contained; also unblocks the SW update path in `SWUpdateToast`, which suppresses auto-reload while a draft exists but has nothing to check yet.

13. **[storage-indicator](storage-indicator.md)** — `GET /v1/store/usage` endpoint backed by the existing quota cache, surfaced as a "X MB / 1 GB" line in settings with a warning at 90%. Straightforward now that media upload has landed and the quota infrastructure is in place.

14. **[message-virtualization](message-virtualization.md)** — Replace the message list with `@tanstack/react-virtual`. Park until there is evidence of real perf degradation; the plain map is fine at current message volumes. Now that scroll-to-bottom has landed, the prerequisite is in place.
