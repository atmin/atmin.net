# I2 — No lost messages under fault

> Part of the [invariants index](./README.md). Priority **P0**.
> Spec: `web/e2e/invariants/no-lost-messages.spec.ts`.

**Statement.** A send that reaches committed remote state (server returns
200 on `POST /v1/send`) must eventually be visible in the recipient's UI,
Local, and Remote layers — **exactly once** — under any of the faults
below. (The complementary "a rejected send must not appear as sent"
half overlaps [I5](./i5-send-outcomes.md) and is asserted there.)

Faults in scope:

- recipient's realtime channel (SSE) was down at send time → delivery
  must fall back to the next mount/navigation sync
- recipient's next `GET /v1/store/list` fails → the message is not lost,
  just deferred to a later sync
- **ambiguous success**: the server committed the envelope but the
  *sender* saw a 5xx (or a dropped connection). `POST /v1/send` retries
  idempotently — it reuses the already-minted `msg_id`, and the server
  keys each envelope on `inbox/{to}/live/{msg_id}` and overwrites — so
  the retry converges to exactly one object, never a duplicate.

**Fault construction.**

- *SSE drop*: abort every `**/v1/events**` on the recipient's context
  (`onerror` just closes — no reconnect, no sync), send while it's dead,
  then reconcile by re-mounting the chat (`resyncChat`).
- *Ambiguous success*: intercept the sender's first `POST /v1/send` with
  Playwright `route.fetch()` (which reaches the server and commits) then
  `route.fulfill({ status: 502 })`; the client's idempotent retry reuses
  the msg_id. Assert no duplicate and no loss.
- *List failure*: arm a one-shot `route.abort()` on `**/v1/store/list**`
  after the initial mount sync, send, then resync; the message surfaces
  on the recovered sync.

**Assertions.**

- For every `msg_id` from a committed send: present in `expectUI`,
  `expectLocal`, `expectRemote` for Alice.
- No `msg_id` appears more than once at any layer.
- For every rejected send: absent from all three layers.

**Permitted divergence.** Remote may lead Local during the reconcile
window (bounded by the sync interval). UI never leads Local.
