# I5 — Send outcomes are unambiguous

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/send-outcomes.spec.ts`.

**Statement.** Every send attempt resolves into exactly one of:
`{ sent, rejected }`. There is no UI state that implies "in flight" or
"sent" without a corresponding Local row and Remote object reachable by
normal inbox sync. No "ghost sent": the sender's bubble renders only
after `send()` resolves and the self-addressed envelope syncs back
(`useChatSend`), so a failed send never leaves a sent-looking row.

A rejected send must not produce Remote objects reachable by a normal
inbox sync. Unreachable orphans (e.g. from a partial server-side write
that was never indexed) are out of scope for this invariant.

(`queued` is intentionally absent — see
[Offline mode § Sending while offline](../offline-mode.md#sending-while-offline)
and ADR-0002 for the Megolm ratchet rationale.)

**Fault construction.**

- *Offline send*: the composer is gated on `online` — offline, the input
  shows "You are offline" and the Send button is disabled, so a send can't
  be attempted (no ghost, no Remote object).
- *Server never accepts the write*: abort `POST /v1/send`. `send()`
  exhausts its idempotent retries (see [I2](./i2-no-lost-messages.md)) and
  throws; the UI alerts and renders nothing; nothing is committed at either
  inbox.

Two cases deliberately *not* tested here, because they aren't ghost-sends:
a *transient* 5xx is retried to success (I2); a 5xx *after* the server
committed is the ambiguous-success case I2 covers via idempotent retry
(the message is delivered; the sender merely saw a failure).

**Assertions.**

- *Accepted:* UI shows it sent, `expectLocal` has a row, and the recipient
  receives it via a normal sync (Remote reachable).
- *Rejected (abort):* UI surfaces an error (alert), renders no bubble,
  `expectLocal` has no row, and neither inbox holds an object.
- *Offline:* Send disabled, no bubble, no Remote object.
- No state where UI says "sent" but Local/Remote disagree.

**Permitted divergence.** None.
