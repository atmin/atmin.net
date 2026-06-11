# Tasks

Active implementation tasks, grouped by milestone and in priority order.
Delete a file once its change lands.

## 🚧 In progress — Rust cutover

- **[rust-cutover](rust-cutover.md)** — adopt the Rust backend, retire Go (ADR-0018 →
  ADR-0019). The port met its exit criterion (e2e green 5×) and passed real-infra interop
  on staging; this is the ordered, fast-forward-preserving cutover: decision ADRs, delete
  `server/`, rename `server-rs/`→`server/`, comment-groom, CI + docs (CONTRIBUTING, ops.md,
  README), flip the deploy trigger back to `master`, ff-merge, tag prod, wire the cleanup
  Job. Digestible commits, staging stays green throughout.

## 🔴 Fix first — *after the cutover* — known data-integrity bug

- **[key-backup-unsafe-session-id-key](key-backup-unsafe-session-id-key.md)** — the
  base64 Megolm `session_id` is used **raw** as an S3 key segment
  (`keys/{uid}/live/{session_id}`); when it contains a `/`, the object name is invalid,
  the **fire-and-forget key backup PUT silently 400s**, and ~4% of sessions' messages
  become **undecryptable on restore** (new device / post-rotation / migration).
  Pre-existing on `master`, backend-agnostic (not the Rust port). **Parked** during the
  cutover only to avoid a mid-transition context-switch — the **first** post-cutover task.
  Found by the `flaky-compare` stress test; trace-confirmed (`XMinioInvalidObjectName`).

## MVP v0.1 — complete ✅ (modulo the bug above)

The v0.1 baseline is done: a self-contained, self-service E2E messenger
(password credentials, handles, rotation, media, edit/delete, account
deletion, cleanup, storage visibility). The last pieces landed as
message-amendments ([ADR-0014](../docs/decisions/adr-0014-message-amendments.md)),
draft persistence (`useDraft`), the storage indicator (`GET /v1/store/usage`),
data-retention cleanup (`cleanup` subcommand, [ADR-0006](../docs/decisions/adr-0006-data-retention.md)),
and account deletion (Settings → Danger zone, `DELETE /v1/profile`, invariant
[I7](../docs/scenarios/invariants/i7-deletion-races.md)).

## MVP v0.2 — background delivery & reach

Scope is still firming up — see [v0.2.md](../docs/specs/v0.2.md).
Push is the headline; the other two support and scale it. New items may
be added here as v0.2 is iterated on.

1. **[push-notifications](push-notifications.md)** — VAPID-keyed Web Push, subscription stored as a field on `users/{uid}/devices/{did}.json` (no new prefix), best-effort fan-out on `/v1/send`, custom service worker (VitePWA `injectManifest`) with `push` + `notificationclick` + `pushsubscriptionchange` handlers, local badge counter, settings toggle. See [ADR-0015](../docs/decisions/adr-0015-web-push.md). iOS users need [ios-install-hint](ios-install-hint.md) (task 2) landed first to receive push at all; everywhere else it ships independently.

2. **[ios-install-hint](ios-install-hint.md)** — Dismissible banner on iOS Safari pointing users toward "Add to Home Screen." Low effort; iOS has no native install prompt so without this the PWA is effectively undiscoverable on the platform. Prerequisite for push notifications (task 1) to work on iOS.

3. **[message-virtualization](message-virtualization.md)** — Replace the message list with `@tanstack/react-virtual`. Park until there is evidence of real perf degradation; the plain map is fine at current message volumes. Now that scroll-to-bottom has landed, the prerequisite is in place.

## Experiments

Not milestone scope — exploratory work gated by its own exit criteria.

- **[rust-backend-spike](rust-backend-spike.md)** — the Rust backend port experiment ([ADR-0018](../docs/decisions/adr-0018-rust-backend-experiment.md), branch `rust-port-experiment`): **complete** — all phases done, exit criterion met (e2e green 5×), staging interop validated. Now graduating to adoption via [rust-cutover](rust-cutover.md) (top of this file); this spike file + its phase log get deleted when the cutover lands.
