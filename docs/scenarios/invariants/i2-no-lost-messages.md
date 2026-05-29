# I2 — No lost messages under fault

> Part of the [invariants index](./README.md). Priority **P0**.
> Spec: _not yet implemented._

**Statement.**

- A send that reaches committed remote state (server returns 200 on
  `POST /v1/send`) must eventually be visible in the recipient's UI,
  Local, and Remote layers, exactly once.
- A send that is rejected must not appear as sent at any layer.

Faults in scope:

- recipient's SSE connection was down at send time
- recipient's next `GET /v1/store/list` first attempt times out
- a `PUT` to a presigned URL failed *after* the object was written
  server-side (ambiguous-success case)

**Fault construction.**

- *SSE drop*: kill Alice's `EventSource` between sends; verify reconcile
  on reconnect.
- *Ambiguous PUT*: use a fault-injection proxy (MinIO middleware) that
  writes the object then returns 502. Client retries; assert no duplicate
  and no loss.

**Assertions.**

- For every `msg_id` from a committed send: present in `expectUI`,
  `expectLocal`, `expectRemote` for Alice.
- No `msg_id` appears more than once at any layer.
- For every rejected send: absent from all three layers.

**Permitted divergence.** Remote may lead Local during the reconcile
window (bounded by the sync interval). UI never leads Local.
