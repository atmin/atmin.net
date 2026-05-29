# I5 — Send outcomes are unambiguous

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: _not yet implemented._

**Statement.** Every send attempt resolves into exactly one of:
`{ sent, rejected }`. There is no UI state that implies "in flight" or
"sent" without a corresponding Local row and Remote object reachable by
normal inbox sync.

A rejected send must not produce Remote objects reachable by a normal
inbox sync. Unreachable orphans (e.g. from a partial server-side write
that was never indexed) are out of scope for this invariant.

(`queued` is intentionally absent — see
[Offline mode § Sending while offline](../offline-mode.md#sending-while-offline)
and ADR-0002 for the Megolm ratchet rationale.)

**Fault construction.**

- *Offline send*: kill network, attempt send. Expect immediate
  rejection.
- *Online send with `POST /v1/send` 500*: server returns error after
  ciphertext was committed by client. Expect explicit failure UI; Local
  must not show a "sent" row.

**Assertions.**

- For every rejected send: no Local row, no Remote object reachable via
  `inbox/{uid}/live/` or `inbox/{uid}/archive/`, UI shows error.
- For every accepted send: Local row present, Remote object present,
  UI shows "sent".
- No state where UI says "sent" but Local/Remote disagree.

**Permitted divergence.** None.
