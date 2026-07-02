# Harden sender-controlled envelope fields

> Clamp `sent_at`; validate `send` object names. **Audit findings:** M4, L5, L8
> · **Priority: High** (M4 is a permanent, cross-device poisoning).

## Why it matters

`sent_at` is a **sender-controlled plaintext** header
([envelope.ts:7](../web/src/lib/envelope.ts)) the server stores verbatim, and
the client trusts it as the ordering clock
([messaging.ts:341](../web/src/lib/messaging.ts): `new Date(envelope.sent_at ?? 0)`).

- **M4 — read-marker CRDT poisoning (permanent, replicated).** A modified sender
  stamps `sent_at` far in the future. The recipient stores it; opening the chat
  pins `lastReadTimestamp` to year-9999 via `markConversationRead`. The monotone
  `max()` merge ([read-markers.ts:45](../web/src/lib/read-markers.ts),
  [db.ts:815](../web/src/lib/db.ts)) makes it **irreversible** and replicates it
  to all current/future devices via `read-markers.json`. Every genuine later
  message then has a smaller timestamp → never counted unread
  ([db.ts:871](../web/src/lib/db.ts)): no badge, no app-icon count, frozen "New"
  divider — for that conversation, forever, surviving reinstall. Messages still
  *render* on open; the unread/notification signal is what's suppressed.
- **L8.** Same root: a future `sent_at` pins the conversation to the top of the
  chat list and as its preview ([db.ts:681](../web/src/lib/db.ts)).
- **L5.** `send` interpolates sender-controlled `to_user`/`msg_id` into the S3
  key with **no** `is_object_name_safe` check, unlike presign
  ([routes.rs:309](../server/src/routes.rs)). An empty `msg_id` → trailing-slash
  key → `XMinioInvalidObjectName` → opaque **500** (not a clean 400) + orphan
  pollution.

## Current

No ingest clamp; `send` skips object-name validation.

## Change

1. Clamp at ingest: `timestamp = min(new Date(sent_at ?? 0).getTime(), Date.now() + SKEW)`
   in [messaging.ts:341](../web/src/lib/messaging.ts). Defence-in-depth: cap
   `markConversationRead`'s input to `Date.now() + SKEW`. Prefer the `msg_id`
   ULID's embedded timestamp for ordering, with a receive-time upper bound.
2. One-time repair migration: clamp any already-poisoned `lastReadTimestamp > now`.
3. `send`: run `is_object_name_safe` on the composed key → `400`; require
   ULID-shaped `msg_id` and UserId-shaped `to_user`.

## Verify

- Ships **[I14](../docs/scenarios/invariants/i14-read-marker-convergence.md)**
  (future-dated message read → a later honest message still surfaces unread).
- Unit: `mergeMarkers` laws unaffected; the ingest clamp bounds the stored
  timestamp.
- Handler test: `send` with empty / slash-bearing `msg_id` → `400`, not `500`.
