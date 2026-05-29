# I7 — Account deletion races terminate cleanly

> Part of the [invariants index](./README.md). Priority **P2**.
> Spec: _not yet implemented — folded into the
> [account-deletion-ui](../../../tasks/account-deletion-ui.md) task, lands
> with that flow._

**Statement.** A `DELETE` initiated while a sync is in flight resolves
deterministically: either the sync completes against pre-delete state and
is then invalidated on the next request, or it aborts mid-flight without
crashing the client.

**Fault construction.**

1. Alice on device 1 starts `DELETE /v1/profile`.
2. Alice on device 2, online concurrently, is mid-sync.
3. Bob sends a message during the window.

**Assertions.**

- Device 2's in-flight sync either completes (returns 200) or fails with
  a recognised auth error. No uncaught exceptions, no infinite retry.
- After deletion settles: device 2 receives 401 on the next request, is
  logged out, IDB is cleared.
- Remote: all `users/{uid}/`, `inbox/{uid}/`, `keys/{uid}/`, and
  `media/{uid}/` objects are absent. `handles/{handle}.json` is *not*
  absent — deletion replaces it with a 30-day cooldown tombstone
  (custom-handles / ADR-0013); resolve returns `410`, not `404`.
- Bob's outbound `POST /v1/send` during the window: either accepted
  (object orphaned and cleaned up) or rejected — must be one of the two,
  never silently lost.

**Permitted divergence.** Brief window where Remote is partially deleted
while Local still reflects logged-in state on device 2. Window bounded by
device 2's next request.
