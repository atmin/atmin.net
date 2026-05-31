# Tasks

Active implementation tasks, grouped by milestone and in priority order.
Delete a file once its change lands.

## MVP v0.1 — finish the baseline

The remaining work to complete [v0.1](../docs/specs/mvp-v0.1.md). Once
these three land, the v0.1 milestone is done: a self-contained,
self-service E2E messenger (password credentials, handles, rotation,
media, edit/delete, account deletion, cleanup, storage visibility).
Edit/delete landed via [message-amendments / ADR-0014](../docs/decisions/adr-0014-message-amendments.md);
draft persistence landed (`useDraft`).

1. **[account-deletion-ui](account-deletion-ui.md)** — Settings → Danger zone panel that wires `DELETE /v1/profile` (already implemented + tested server-side) to a user-facing flow. Password is re-derived against `profile.auth_public_key` as a cryptographic gate (same pattern as change-password), plus typed-handle confirmation + acknowledgement checkbox before the destructive call. Covers the 30-day handle cooldown surfacing and the multi-device-sign-out propagation. Closes the GDPR-baseline gap of "user cannot leave without operator help." Also carries the deferred account-deletion scenario e2e and the **I7** (deletion-races) invariant spec — both land with this flow.

2. **[server-cleanup-routine](server-cleanup-routine.md)** — Automated S3 cleanup for inactive and abandoned accounts plus expired handle tombstones (sweep target added by custom-handles). The `last_active` tracking prerequisite is already in place; this is the production-health item most at risk of being deferred indefinitely.

3. **[storage-indicator](storage-indicator.md)** — `GET /v1/store/usage` endpoint backed by the existing quota cache, surfaced as a "X MB / 1 GB" line in settings with a warning at 90%. The quota is already enforced server-side; this gives users visibility before they hit the cap blind.

## MVP v0.2 — background delivery & reach

Scope is still firming up — see [mvp-v0.2.md](../docs/specs/mvp-v0.2.md).
Push is the headline; the other two support and scale it. New items may
be added here as v0.2 is iterated on.

4. **[push-notifications](push-notifications.md)** — VAPID-keyed Web Push, subscription stored as a field on `users/{uid}/devices/{did}.json` (no new prefix), best-effort fan-out on `/v1/send`, custom service worker (VitePWA `injectManifest`) with `push` + `notificationclick` + `pushsubscriptionchange` handlers, local badge counter, settings toggle. See [ADR-0015](../docs/decisions/adr-0015-web-push.md). iOS users need [ios-install-hint](ios-install-hint.md) (task 5) landed first to receive push at all; everywhere else it ships independently.

5. **[ios-install-hint](ios-install-hint.md)** — Dismissible banner on iOS Safari pointing users toward "Add to Home Screen." Low effort; iOS has no native install prompt so without this the PWA is effectively undiscoverable on the platform. Prerequisite for push notifications (task 4) to work on iOS.

6. **[message-virtualization](message-virtualization.md)** — Replace the message list with `@tanstack/react-virtual`. Park until there is evidence of real perf degradation; the plain map is fine at current message volumes. Now that scroll-to-bottom has landed, the prerequisite is in place.
