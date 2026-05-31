# ADR-0014: Message edits and deletes via amendment envelopes

Status: Accepted
Date: 2026-05-25

## Context

Messages today are immutable from the moment they're sent. The
sender's envelope lands in the recipient's inbox prefix, sync
moves it to the recipient's device, compaction eventually folds
it into an append-only CBOR archive. Nothing in the pipeline
supports retraction or amendment.

Two user-facing operations are missing as a result: editing a
typo or wrong word, and deleting a message regretted after the
fact. Both are table-stakes for a modern messenger.

Neither can be implemented as a *real* mutation:

- Archive objects are append-only CBOR arrays; modifying one in
  place isn't supported by the storage API and would defeat
  compaction's idempotency.
- Recipient devices may have already synced the original; the
  bytes are out of the sender's control the moment SSE fires.
- Multi-device sync means the sender's own other devices already
  hold the original.

Both operations therefore reduce to the same shape: a follow-up
envelope that *references* the original and instructs readers to
present it differently. This ADR specifies that shape.

The two operations are bundled into one ADR because they share
the same protocol primitive and ~95% of the implementation.

## Decision

### Amendment envelope

An amendment is a regular `megolm.message` envelope (the existing
content type — no envelope union change) whose decrypted inner
plaintext is:

```json
{
  "type": "amendment",
  "target_msg_id": "01HWQA...",
  "action": "edit" | "delete",
  "body": "new text"
}
```

`body` is present iff `action: "edit"`. The amendment is
encrypted with the sender's current Megolm session (same as a
normal message) and addressed to the same recipients as the
original — including a self-copy for the sender's other devices.

The `target_msg_id` lives inside the encrypted plaintext. The
server never learns which message is being amended; it only sees
an opaque envelope flowing through the inbox like any other.
This preserves the trust property already established by
[ADR-0002](adr-0002-ecies-not-olm.md) and reaffirmed by
[ADR-0008](adr-0008-p256-sharing-keypair.md).

### Authorization

The recipient verifies, at materialization time, that the
amendment's `from_user` equals the original message's `from_user`.
Megolm session integrity (the same property that proves a normal
message wasn't forged) covers the cryptographic side. No new
signatures, no new keys.

A device that compromises the sender's account can amend any of
the sender's prior messages — but that device can also send
arbitrary new messages as the sender, so this is not a new
attack surface.

### Materializer logic

[useChat.ts:toMessages](../../web/src/hooks/useChat.ts) becomes a
two-pass walk over the decrypted messages:

1. **First pass — partition.** Collect amendments into a
   `Map<target_msg_id, Amendment[]>`, ordered by `msg_id`
   (which is ULID, so chronological).
2. **Second pass — materialize.** Walk the originals. For each,
   look up its amendment list and apply in order:
   - `action: "edit"` → replace `body` with the amendment's
     `body`; tag the resulting `Message` with
     `edited_at: amendment.sent_at`.
   - `action: "delete"` → set a `deleted: true` flag on the
     `Message`; drop the `body` and `media` fields.
   - Multiple amendments compose. A `delete` after any edits
     wins terminally (no further amendments are processed).
3. **Orphan amendments** (target not yet in IDB) stay in IDB
   and re-attempt on each subsequent sync. They land naturally
   once the original arrives through normal sync paths
   (live, archive walk-back).

The chain order is "latest edit wins, delete trumps edits." The
full chain is preserved in storage; the materializer just picks
the terminal state.

### UI semantics

- Edited messages render the current body plus a small
  `(edited)` tag carrying the amendment's `sent_at`. The
  delta between original `sent_at` and amendment `sent_at`
  is surfaced for long-after edits ("edited 3 weeks later")
  so silent gaslighting reads visually loud.
- Deleted messages render as a `[deleted]` placeholder in
  place of the original — same position in the chat, same
  timestamp, same author. Preserves reply context and is
  honest about the redaction.
- No edit history view in v0.1 (the chain *exists* in
  storage, so this UI lands later as pure presentation work).
- No "delete for me" (local-only UI hide) — that's a different
  feature, IDB-level, no protocol support needed; defer.

### No time window

Edit and delete work indefinitely. The UI labels (sent_at delta,
"(edited)" tag) carry the information that lets recipients
calibrate trust. Time caps add an arbitrary UX cliff without
materially constraining bad-faith amendment.

### Edit scope on media messages

- Text messages: `body` is replaced.
- Media messages with captions: the caption text is replaced;
  the media reference (`file`) is unchanged.
- Pure-media messages (no caption): no edit allowed; UI exposes
  only delete. The amendment with `action: "edit"` on such a
  message is malformed and ignored by the materializer.

### Media side effect on delete

When the sender deletes a message that carried a media
reference, the sender's device additionally issues
`DELETE /v1/store/object?key=media/{uid}/{ulid}` for the
referenced blob. The recipient, on processing the delete
amendment, drops its local IDB cache of the decrypted blob.
A recipient that hadn't yet downloaded the blob will see 404
on attempted fetch → render "media unavailable."

The media-deletion side effect is best-effort. If the sender's
DELETE call fails (network drop, server unavailable), the
amendment still propagates and recipients still see
`[deleted]`. A future cleanup pass (orphan-media sweep, ADR-0006
territory) catches the abandoned blob.

### Unknown amendment types

Forward compatibility for future amendment kinds (reactions,
disappearing-message TTL hints, …) lives in the inner-type
dispatch. A client that encounters an amendment with an
unrecognized `action` field — or for that matter an unknown
inner `type` — **drops the envelope silently** from
materialization. Better to miss a feature than to render
garbage.

## Consequences

### Positive

- Two of the most-requested messenger features land with one
  inner-plaintext shape and a two-pass materializer. No new
  envelope content type. No new keys. No new endpoints.
- `target_msg_id` inside the encrypted plaintext keeps the
  server out of the amendment semantics — it remains a blind
  storage proxy.
- "No time limit" gives users honest agency over their own past
  words. UI labels make the audit trail clear.
- The full edit chain stays in storage. "View history" UI is a
  pure presentation feature that lands whenever the demand
  appears, no storage rework.
- Compaction is unchanged. Amendments are just envelopes; they
  pack into archives the same as anything else.

### Negative

- Pathological edit chains (someone editing a message 100 times)
  bloat the archive linearly. Acceptable at expected usage; can
  be revisited if it becomes a problem (compaction-time squash
  is a small follow-up, not a structural change).
- The two-pass materializer is O(N) per sync. Negligible at
  current message volumes; if [message-virtualization](../../tasks/message-virtualization.md)
  ever lands the per-render cost stays the same (still O(N) on
  initial load).
- Recipients online at the moment of the original send see the
  pre-edit text briefly before the amendment arrives. The
  amendment lands within the SSE round-trip window in practice;
  cosmetic at worst.
- The "(edited)" tag is the only signal recipients see that the
  text changed. We rely on the UI to surface it honestly; same
  trust model as every other messenger.

### Neutral

- An amendment is its own envelope with its own `msg_id` (a
  fresh ULID). It costs one inbox object per amendment, same
  as any other message.
- Amendments use the same Megolm session as the message they
  amend was *not* required to use — they're sent in the
  current session, not the original's. Megolm session
  rotation across edits is the same as across any messages.
- `last_active` ticks on every amendment as on any send.

## Migration

This is v0.1 work, pre-launch — no existing amendments to
migrate, no clients in the wild to handle the new inner type.
The "unknown type → silent drop" rule is forward-compatible for
future amendment kinds added after launch.

## Alternatives considered

### New envelope `content_type: "megolm.amendment"`

Rejected. Adding a content type just to express "this envelope
is an amendment" buys nothing the inner-type dispatch doesn't
already give us. The send/sync/archive pipeline is content-type-
agnostic at the server, and the client already dispatches on
inner `type` to distinguish text from media. Amendments slot in
there naturally.

### Server-enforced deletion

Rejected. Letting the server act on "delete this message" by
removing the inbox object directly would require the server to
understand what an amendment *means* — a content-aware code
path in an otherwise content-agnostic proxy. It also wouldn't
solve the multi-device sync problem (recipients' other devices
already cached the original). The amendment-envelope approach
keeps the server out of the semantics.

### Diff-based "edit" payload

Rejected. The original framing in conversation used "delta" as
shorthand for "the change," not for a literal text diff. Full
body replace is simpler (one shot to render the current state),
needs no diff/patch library on either side, and the bandwidth
difference for typical message lengths is negligible.

### Time-bounded edits (24h / 48h cap)

Rejected per the *Decisions* table. UI labeling carries enough
information ("edited 3 weeks later") for recipients to
calibrate trust without imposing an arbitrary cliff.

### Squash edit chain on compaction

Rejected. Keeping the chain costs little (pathological cases are
rare; a future compaction-squash pass remains addable) and
preserves the ability to add "view history" UI as pure
presentation work later. Squashing now would require either a
later schema change to add history, or a permanent loss of edit
provenance.

### Forward-secret edits (re-key per edit)

Rejected. Recipients already hold the Megolm session keys for
both the original and the amendment; re-keying adds no new
forward secrecy. Pure complexity, no gain.

### Reactions, disappearing messages

Out of scope. Reactions have multi-author semantics that don't
fit the single-author amendment model. Disappearing messages
need a TTL/timer story orthogonal to user-initiated amendment.
Both deserve their own ADRs.

### Delete-for-me (local-only UI hide)

Out of scope. Doesn't need any protocol support — pure IDB
flag, set by the client on a user gesture. If/when the UI
offers it, it lands as a one-task UI feature with no schema or
server changes.
