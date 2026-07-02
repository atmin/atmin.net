# SSE resilience (reconnect, reconcile, revoke-teardown)

> **Audit findings:** M2, L4, M5 · **Priority: Medium** (M2 is mass-triggered by
> every redeploy).

## Why it matters

- **M2 — SSE dies silently after one transient error.** `events.onerror = () =>
  events.close()` ([useInboxSync.ts:28](../web/src/hooks/useInboxSync.ts))
  cancels EventSource's built-in auto-reconnect. The effect's deps are
  `[session, sessionManager, online]`, so the only re-open triggers are a
  session change or an `onLine` flip — **not** a remount (the hook is
  app-root-mounted, so in-app navigation doesn't remount it) and **not** a brief
  blip. A redeploy (min-scale=1 → every client's stream errors at once), an LB
  idle timeout, or a missed heartbeat kills realtime for the rest of the
  session; incoming messages then produce no badge/update until the user
  reloads, toggles connectivity, or sends. No data loss (a mount-time sync
  eventually pulls) — degraded realtime UX, mass-triggered by redeploys.
- **L4 — poll-vs-subscribe gap.** On mount, the initial `syncAndPublish` list
  and the EventSource open race; a `new_message` fired between the list snapshot
  and server-side `register()` is dropped for that connection. Recovers on the
  next trigger — but an idle recipient waits.
- **M5 — revoked device keeps its live stream (timing side-channel).** The auth
  guard runs only at connect. The hub is keyed by `user_id` and `Conn` has no
  `device_id` ([events.rs](../server/src/events.rs)), so a revoked device's
  already-open stream is never torn down: it keeps receiving content-free
  `new_message` events, leaking the victim's incoming-message timing/frequency
  in real time until the socket drops. (Content stays E2E-encrypted; the inbox
  itself is guard-blocked.)

## Current

`onerror` closes; app-root mount means navigation doesn't re-poll; `Conn` has no
`device_id`.

## Change

1. In `onerror`, do **not** `close()` — let EventSource auto-reconnect; only
   `close()` on effect cleanup (unmount/offline).
2. Reconcile safety net: call `syncAndPublish` on `visibilitychange`→visible and
   on `focus`, and/or add a `connected`-event listener (the server registers the
   subscription before yielding `connected`, closing the L4 window
   deterministically).
3. M5: tag each `Conn` with `device_id`; give revoke/delete-device a
   `hub.drop(user_id, device_id)` (dropping `tx` closes the channel → the
   stream's `recv()` returns `None` → loop breaks). Belt: re-check the device
   key on each heartbeat tick and break on `NotFound`.

## Verify

- Test firing `onerror` while online → the stream re-establishes and a
  subsequent message arrives without a reload.
- Test: revoke a device holding an open stream → its stream is torn down (no
  further events).
