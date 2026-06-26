# ADR-0026: Cross-device read markers (zero-knowledge, CRDT merge)

Status: Draft
Date: 2026-06-26

Reuses the `contacts.json` pattern ([ADR-0005](adr-0005-profiles-and-contacts.md)):
a client-owned, backup-key-encrypted blob the server stores but cannot read.
Preserves the read-receipts non-goal ([vision.md](../vision.md) Non-goals).
Bounded by [ADR-0015](adr-0015-web-push.md): the closed-app case is out of scope.

## Context

The messenger tracks unread locally (a per-conversation `lastReadTimestamp` in
IndexedDB) to drive an app-icon badge, per-row counts, and a `── New ──` divider.
That read position must follow the user across devices: catch up on the phone,
open the laptop, and the laptop should *not* flood you with fake "new." So read
position has to sync.

But read position is sensitive metadata — which conversations you have, and how
recently you've engaged each. The server holds none of it today, and shouldn't
start. This is **self-state, not a read receipt**: it answers "what haven't *I*
seen," never signals the peer, and so does not touch the read-receipts non-goal.
The question is purely: how to sync a per-conversation watermark across devices
**without the server learning anything**, and without adding server-side state or
coordination to a deliberately stateless relay.

## Decision

Store read markers as a **single client-owned encrypted blob** at
`users/{uid}/read-markers.json` — exactly the `contacts.json` posture:
AES-256-GCM under the on-device **backup key**, wrapped in the existing
`KeyBackupEnvelopeV2 {v, iv, ciphertext}`, written by presigned PUT and read by
authenticated GET. The server stores opaque ciphertext. The decrypted blob is
`{ v: 1, markers: { [conversationId]: lastReadMs } }` (a plaintext schema version,
distinct from the envelope's `v` = `key_version`).

Four properties make this near-free and unconditionally correct:

- **One blob, not per-conversation objects.** Object *names* like
  `read-markers/dm:U1:U2` would leak the social graph in S3 keys — the very
  metadata the encryption hides. One blob keeps read markers in the same metadata
  class as contacts: the server sees "an opaque blob changed," nothing more.
- **Monotone merge = a CRDT.** Each marker only ever increases, so merge is
  per-conversation `max()`. A device GETs the remote blob, merges it into local by
  `max()`, and — if any local marker advanced past remote — re-encrypts and PUTs.
  Concurrent writers converge: a PUT landing on stale data is healed by the next
  GET-merge on either device. `max()` is commutative, associative, and idempotent,
  so no mutex, no server-side conflict logic, no read-state endpoint.
- **Watermark = the message's own timestamp**, not wall-clock-at-read. Merge is
  therefore immune to device clock skew; per conversation, whichever device read
  *further into the thread* wins.
- **No server change, and rotation survival for free.** `authorize_key_write`
  already permits any `users/{uid}/*` key, and presign/object are generic. A blob
  written under a rotated-away backup key opens via the envelope's `v` + key-chain
  walk, exactly as `restoreContacts` already does.

## Consequences

- **+** Read position follows the user; a second device stops showing fake "new"
  on its next foreground sync. Zero server work — no endpoint, no migration, no
  shared state.
- **+** Same metadata class as contacts: the server learns only that an opaque
  blob changed, never which chats exist or when they were read.
- **+** Convergence is unconditional, straight from monotonicity. The only thing a
  racing write can "lose" is a *lower* watermark — precisely what `max()` discards.
- **−** Eventual, not instant: a device reflects another's reads only on its next
  foreground GET (sync is foreground-only — ADR-0015). Read position is not
  time-critical; acceptable.
- **−** Whole-blob read/write: each sync GETs, and when advanced PUTs, the full
  marker map. Fine at hundreds–thousands of conversations; if it ever isn't,
  compaction mirrors the `keys/` archive pattern. A known scaling lever, not a v1
  concern.
- **−** If the key chain is ever broken (shouldn't happen — rotation writes
  `key_chain.json`), an old blob won't open and markers fall back to local: a
  cosmetic re-show of "new," never data loss.
- Closed-app badge staleness is out of scope (ADR-0015) — this ADR governs the
  data model, not background delivery.
- **−** The home-screen **app-icon badge does not appear on installed iOS web
  apps.** `setAppBadge` exists there (the feature-detect passes) but iOS gates
  it behind notification permission, which we deliberately don't request
  (ADR-0015) — so on iOS the call is a silent no-op. Decided to leave it
  unsupported on iOS this milestone (the in-app chats badge + `New` divider
  carry unread) rather than prompt for notifications; the icon badge works on
  desktop Chrome/Edge and Android. Revisit with the native/notifications story.
- Stays **Draft** until implemented and verified on two real devices (read on one,
  confirm the other catches up) — not flipped to Accepted on optimism.

## Alternatives considered

- **Per-conversation objects** (`read-markers/{conversationId}`): natural for
  partial writes, but the object names leak the social graph in plaintext S3 keys —
  exactly what the single blob hides. Rejected.
- **Server-side read state** (a read-markers endpoint or column): trivial and
  instant across devices, but the server would learn which chats you have and when
  you last read each — breaks the zero-knowledge boundary the design exists to
  protect. Rejected.
- **A locking / version (ETag, `If-Match`) scheme:** needed only if writes weren't
  commutative. They are — `max()` is a CRDT join — so coordination buys nothing but
  latency and a round-trip. Rejected.
- **Last-writer-wins by wall-clock-at-read** instead of message timestamp: simpler
  until two devices' clocks disagree, at which point a fast clock marks
  conversations read past where you actually are. The message-timestamp watermark
  sidesteps clocks entirely. Rejected.
