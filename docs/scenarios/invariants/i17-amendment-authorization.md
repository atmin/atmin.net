# I17 — Amendments apply only from their author

> Part of the [invariants index](./README.md). Priority **P1**.
> Spec: `web/e2e/invariants/amendment-authorization.spec.ts` — not yet written.

**Statement.** A message's rendered content can be changed by exactly one
party: its original sender. An amendment envelope whose outer `from_user`
differs from the target message's sender is inert — on every device,
including a fresh restore, at UI and Local layers — and its arrival never
crashes or wedges materialization. Replaying a legitimate amendment under a
fresh `msg_id` is idempotent: same rendered outcome, no double-apply
artifacts.

`target_msg_id` lives inside the encrypted plaintext (ADR-0014), so the
server cannot police this; the guard is the client materializer's author
check (the "authorized amendment chain" in `web/src/lib/db.ts`). This
invariant makes that guard hold end-to-end against a forged envelope sitting
in a real inbox.

**Fault construction.** The forge reuses `putObject` (the
[I3](./i3-archive-live-boundary.md) move): capture a *real* amendment
envelope from the account's inbox (live or archive), then re-put it under a
fresh ULID key with the outer `from_user` flipped to a third registered
account. The Megolm ciphertext stays decryptable — inbound-session lookup is
by the envelope's `session_id`, which the recipient already holds — so the
author check is isolated as the only line of defense. Two variants:

1. _Forged author, valid ciphertext:_ `from_user` = Mallory, inner plaintext
   is Bob's edit targeting Bob's message → must not apply (author mismatch).
2. _Replay:_ the untouched Bob amendment under a new `msg_id` → applies
   idempotently; the rendered state is indistinguishable from the first
   application.

If the client's decrypt path refuses the sender mismatch outright, the forge
is inert by undecryptability — also a pass. The assertion is on the outcome,
not the mechanism.

**Assertions.**

- The target message renders unamended (original text; no `edited` tag, no
  `[deleted]`) on the device that syncs the forged envelope live **and** on a
  fresh device that restores it from the archive.
- Local: the target row's materialized state is unchanged; the forged
  envelope never contributes to the target's amendment chain.
- The chat-list preview (derived from the latest-message summary) is
  unchanged.
- No uncaught errors; sync completes normally around the hostile envelope.

**Permitted divergence.** None at any layer for the rendered state. (The
forged envelope may exist as an S3 object and even as a stored Local row —
inertness is about rendered content and summaries, not about scrubbing the
hostile bytes.)
