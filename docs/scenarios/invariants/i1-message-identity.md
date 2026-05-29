# I1 — Message identity is unique across layers

> Part of the [invariants index](./README.md). Priority **P0**.
> Spec: `web/e2e/invariants/no-duplicate-messages.spec.ts`.

**Statement.** For any `msg_id`, every device shows at most one bubble and
holds at most one IDB row — under any combination of:

- SSE `new_message` events delivered while a sync is in flight
- explicit refetch after `POST /v1/send`
- archive/live overlap during compaction (see [I3](./i3-archive-live-boundary.md))
- client-side retry of an idempotent `POST /v1/store/compact`

Remote uniqueness is strict **within** the live prefix and **within** each
archive object. Across live and archive, temporary duplication is permitted
only during the compaction window covered by [I3](./i3-archive-live-boundary.md).
UI and Local deduplication remain strict regardless.

**Fault construction.**

1. Register Alice and Bob.
2. Bob sends a burst to Alice while Alice's `GET /v1/store/list` is
   delayed (delay must outlast all burst sends so the list fires only
   after all messages are in S3 — see `LIST_DELAY_MS` in the spec).
3. Refresh Alice mid-burst.

**Assertions.**

- `expectUI(alicePage, { messageCount: BURST })`
- `expectLocal(alicePage, convId, { uniqueMsgIdCount: BURST, ordered: true })`
- `expectRemote`: no duplicate keys within `inbox/{uid}/live/`
- Order: monotonic by `msg_id` (ULID lexicographic) at UI and Local layers.

**Permitted divergence.** None at UI or Local. At Remote: temporary
live+archive overlap only during the compaction window
([I3](./i3-archive-live-boundary.md)).
