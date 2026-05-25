# Message edits and deletes via amendment envelopes

Two of the most-requested missing features (edit and delete) land
as one feature because they share the same primitive: an amendment
envelope referring to a prior `msg_id`. The protocol cost is one
new inner-plaintext `type`; everything else is materializer logic
and UI.

Specs:
[ADR-0014](../docs/decisions/adr-0014-message-amendments.md),
[mvp-v0.1.md#payload-by-content-type](../docs/specs/mvp-v0.1.md#payload-by-content-type),
[mvp-v0.1.md#materialization-chat-view-assembly](../docs/specs/mvp-v0.1.md#materialization-chat-view-assembly).

## Current state

- [envelope.ts](../web/src/lib/envelope.ts) — `Envelope` union is
  `KeyShareEnvelope | MessageEnvelope`. Unchanged by this task;
  amendments ride the existing `megolm.message` envelope.
- [useChat.ts:37-86](../web/src/hooks/useChat.ts#L37) — `parseMediaEnvelope`
  + `toMessages` do single-pass materialization. Dispatch on
  decrypted inner JSON's `type` (`"text"` or `"media"`).
  No notion of amendment, edit, delete, or orphans.
- [messaging.ts:29-140](../web/src/lib/messaging.ts#L29)
  `sendTextMessage` packs `{type, body, file?}` text and sends.
  No amendment send path.
- [db.ts:44-52](../web/src/lib/db.ts#L44) `StoredMessage` shape
  has `text`, `timestamp`, no edit/delete fields.
- [ChatMessage.tsx](../web/src/components/ChatMessage.tsx) —
  renders a message bubble. No "(edited)" tag, no "[deleted]"
  placeholder, no edit/delete affordances.
- Server is content-agnostic for inbox envelopes; nothing to
  change server-side for amendments themselves. Media deletion
  uses the existing `DELETE /v1/store/object` path
  ([handlers.go](../server/handlers.go)).

## Architecture constraints

- [lint-architecture.sh](../web/scripts/lint-architecture.sh) —
  no side-effect hooks in `components/`; the materializer lives
  in `useChat` (already a hook); the edit/delete actions live in
  a new hook called from the route.
- Inner plaintext stays JSON-encoded. The existing
  `parseMediaEnvelope` style discriminates on `type`; we add a
  third branch.
- `target_msg_id` lives inside the encrypted plaintext (never
  on the envelope) so the server cannot link amendments to their
  targets.

## Change

### 1. Inner-plaintext schema

Define the amendment shape in [messaging.ts](../web/src/lib/messaging.ts)
(new exported types) so the send and materialize paths share
one source of truth:

```ts
export interface TextPayload {
    type: 'text';
    body: string;
}

export interface MediaPayload {
    type: 'media';
    body: string;  // caption
    file: { url: string; key: string; iv: string; name: string; size: number };
}

export type AmendmentAction = 'edit' | 'delete';

export interface AmendmentPayload {
    type: 'amendment';
    target_msg_id: string;
    action: AmendmentAction;
    body?: string;  // present iff action === 'edit'
}

export type InnerPayload = TextPayload | MediaPayload | AmendmentPayload;
```

[useChat.ts](../web/src/hooks/useChat.ts) imports these instead
of declaring its own `MediaEnvelope` interface locally.

### 2. Send path

New `web/src/lib/amendments.ts`:

```ts
export async function sendAmendment(
    token: string,
    fromUserId: string,
    fromDeviceId: string,
    toUserId: string,
    toPublicKeyBytes: Uint8Array,
    selfPublicKeyBytes: Uint8Array,
    targetMsgId: string,
    action: AmendmentAction,
    body: string | undefined,
    sessionManager: SessionManager,
): Promise<void>
```

Internally this is `sendTextMessage` with a different inner
payload. Factor [messaging.ts:sendTextMessage](../web/src/lib/messaging.ts#L29)
to take an arbitrary `InnerPayload` instead of a `messageText`
string, and have `sendAmendment` and the existing send paths
both go through the new generic function:

```ts
// Renamed; takes any InnerPayload.
export async function sendInnerPayload(
    token, fromUserId, fromDeviceId, toUserId, toPublicKeyBytes,
    selfPublicKeyBytes, payload: InnerPayload, sessionManager,
): Promise<void>
```

Existing `sendTextMessage(... messageText)` becomes a tiny
wrapper passing `{type: 'text', body: messageText}` (or the
`{type: 'media', ...}` shape for media). `sendAmendment` is the
third caller.

### 3. Storage: amendment-aware `StoredMessage`

[db.ts](../web/src/lib/db.ts):

```ts
export interface StoredMessage {
    id: string;
    userId: string;
    conversationId: string;
    fromUser: string;
    fromDevice: string;
    text: string;
    timestamp: number;

    // New, all optional. Populated for amendments only.
    inner_type?: 'text' | 'media' | 'amendment';
    target_msg_id?: string;
    action?: 'edit' | 'delete';
    body?: string;
}
```

Bump `DB_VERSION` and extend the existing migration ladder
([db.ts:onupgradeneeded](../web/src/lib/db.ts)) — existing
stored messages survive untouched (the new fields are optional).

No new index. The materializer (step 4) loads the whole
conversation and partitions in memory, so an index on
`target_msg_id` adds schema surface without speeding anything up.
If a future "react to amendment arrival in real time without
re-materializing" hot path appears, an index can be added then.

### 4. Materialization rewrite

[useChat.ts:toMessages](../web/src/hooks/useChat.ts#L58) becomes
a two-pass walker, as specified in
[ADR-0014 — Materializer logic](../docs/decisions/adr-0014-message-amendments.md#materializer-logic):

```ts
interface MaterializedMessage extends Message {
    edited_at?: Date;
    deleted?: boolean;
}

function toMessages(
    stored: StoredMessage[],
    userId: string,
): MaterializedMessage[] {
    // First pass — partition
    const amendmentsByTarget = new Map<string, StoredMessage[]>();
    const originals: StoredMessage[] = [];
    for (const m of stored) {
        if (m.inner_type === 'amendment' && m.target_msg_id) {
            const list = amendmentsByTarget.get(m.target_msg_id) ?? [];
            list.push(m);
            amendmentsByTarget.set(m.target_msg_id, list);
        } else {
            originals.push(m);
        }
    }

    // Second pass — apply
    return originals.map((orig) => {
        const base: MaterializedMessage = /* existing text/media materialization */;
        const chain = amendmentsByTarget.get(orig.id) ?? [];
        // chain is already in ULID order from the IDB index
        for (const a of chain) {
            if (a.fromUser !== orig.fromUser) continue; // authz
            if (a.action === 'edit' && a.body !== undefined) {
                base.text = a.body;
                base.edited_at = new Date(a.timestamp);
            } else if (a.action === 'delete') {
                base.deleted = true;
                base.text = '';
                base.media = undefined;
                break; // terminal
            }
            // unknown action → silently skipped
        }
        return base;
    });
}
```

Orphan amendments (no matching original in the same conversation)
are *kept in IDB* but not surfaced. Each subsequent
materialization pass picks them up if the original has since
arrived.

**Orphan retention policy.** Orphans are kept *forever* in v0.1.
The storage cost is one row per orphan (a few hundred bytes), and
the legitimate cases that produce orphans (out-of-order sync,
network reorderings around send + immediate edit) resolve within
seconds. The pathological case — an orphan whose target never
arrives, e.g. because the sender deleted the original before it
ever reached the recipient — leaves a forever-row in IDB. We
accept this for v0.1. If unbounded growth ever becomes
observable, a "drop orphans older than 30 days" sweep is a small
follow-up and does not affect protocol correctness.

### 5. UI: ChatMessage rendering

[ChatMessage.tsx](../web/src/components/ChatMessage.tsx):

- `deleted: true` → render the bubble with a muted `[deleted]`
  string at the original position with the original timestamp.
  Same author column (sent vs received). No body, no media,
  no action affordances.
- `edited_at: Date` → render an `(edited)` tag inline near
  the timestamp. Title attribute (`title="Edited at ...Z, X
  hours after original"`) for the long-after-edit hint.

The bubble stays presentational. No side-effect hooks.

### 6. UI: message actions

New [MessageActions.tsx](../web/src/components/MessageActions.tsx):
a small menu (long-press on touch, hover-show on desktop) per
message bubble. For the user's own messages: "Edit" (text or
media-with-caption only) and "Delete." For others' messages:
nothing (v0.1 — no "delete-for-me" yet).

Actions wire to props from a new hook
[useChatAmendments.ts](../web/src/hooks/useChatAmendments.ts):

```ts
export function useChatAmendments(
    session: Session,
    sessionManager: SessionManager | null,
    handle: string | undefined,
): {
    editMessage: (msgId: string, newBody: string) => Promise<void>;
    deleteMessage: (msgId: string, mediaUrl?: string) => Promise<void>;
}
```

The hook resolves the recipient (same path as `useChatSend`
does today), calls `sendAmendment`, and on delete additionally
fires `storeDelete(mediaUrl)` if the original was a media
message (best-effort; logged on failure but not user-facing —
the amendment alone satisfies user intent).

### 7. Edit UI affordance

Editing the current message in-place would require a different
component shape; simpler v0.1 UX: clicking "Edit" opens an
inline text input pre-filled with the current body, with
"Save" / "Cancel" buttons. On save, calls
`editMessage(msgId, newBody)`. Implemented in
[ChatMessage.tsx](../web/src/components/ChatMessage.tsx) via a
`editing: boolean` prop owned by the parent (
[ChatView.tsx](../web/src/components/ChatView.tsx)) so only one
message edits at a time.

Caption editing for media messages: same affordance, the input
edits only the caption text; the media block continues to
render above.

### 8. Recipient-side media cache cleanup

When a `delete` amendment arrives for a media message:

- The materializer marks `deleted: true` (drops the media
  reference from the materialized message).
- A best-effort `deleteMediaCache(mediaUrl)` runs to purge any
  decrypted blob in IDB / the cache layer used by
  [useMedia](../web/src/hooks/useMedia.ts). The exact API
  depends on the current cache shape; pick the smallest
  surface change.

### 9. Out-of-order / orphan handling

When materialization runs:

- If an amendment has no matching original in this
  conversation's `StoredMessage` set, it stays in IDB and is
  simply skipped during the second pass.
- Each sync triggers a fresh materialization. If the original
  has arrived in between, the amendment now finds its target.
- No explicit "pending" flag is needed in storage — the
  second-pass logic already handles "no target found" by
  ignoring the amendment.

### 10. Server: no changes

Inbox/archive endpoints carry amendment envelopes
transparently. The only server-side concern is the existing
`DELETE /v1/store/object` for media — already implemented per
[handlers.go](../server/handlers.go); no new behaviour. The
authorization check (caller owns the prefix) already covers
"only the sender can delete their own media."

## Out of scope

- Edit history viewing UI. The chain is stored, but v0.1
  surfaces only the current state plus an `(edited)` tag.
  Adding a "see history" affordance is a pure-UI follow-up.
- Delete-for-me (local-only hide of a received message). No
  protocol support needed; a future UI feature can implement
  it as an IDB flag without touching this task's surface.
- Reactions. Different shape (multi-author accumulation);
  separate ADR.
- Disappearing / TTL messages. Different shape (timer-driven,
  not user-initiated); separate ADR.
- Compaction-time chain squash. Pathological case; deferred.
- "Reply to a deleted message" UI affordance. The placeholder
  preserves enough context; richer reply UX is a separate
  feature.

## Verify

`make fmt lint test` clean.

**Vitest:**

- `messaging.test.ts` (extend) — **refactor regression**. This
  is the most important test in the task: `sendTextMessage`
  becomes a thin wrapper over the new `sendInnerPayload`, and
  every message in the system flows through this path. Capture
  the envelope bytes produced by the current `sendTextMessage`
  for a fixed input (deterministic by stubbing
  `ulid()` and `new Date()`), commit them as a fixture, and
  assert the refactored code produces byte-identical output
  for: a pure-text message, a media message, and a saved-self
  message. If this test fails, the refactor changed the wire
  format and the credential-overhaul invariants
  ([ADR-0011](../docs/decisions/adr-0011-credential-derivation.md))
  are at risk. Existing `useChatSend.test.ts` continues to pass
  unmodified — it exercises `sendTextMessage` via the same
  public signature, so the refactor must not change behaviour
  there either.

- `amendments.test.ts`:
  - `sendAmendment` posts a `megolm.message` envelope whose
    decrypted plaintext has `type: 'amendment'`,
    `target_msg_id`, `action`, and (for edit) `body`.
  - The `target_msg_id` does **not** appear anywhere on the
    outer envelope (server-visible bytes contain only the
    standard envelope fields).
  - Self-copy is included when sending to a different user.

- `useChat.test.ts` (extend) — materializer:
  - **No-amendment regression**: snapshot
    `toMessages([text-only, media-with-caption, media-only])`
    output. Capture the current (pre-rewrite) output as the
    fixture so the two-pass rewrite is provably non-disruptive
    for chats that contain no amendments. This is the second
    "the refactor didn't break the common case" test, paired
    with the messaging.test.ts byte-equality one above.
  - Single edit: original text "A" + amendment with edit
    body "B" → materialized message has text "B" + `edited_at`.
  - Multiple edits in order: applied in ULID order, final
    text is the last edit's body.
  - **Pathological chain (N=50)**: original + 50 sequential
    edits. Materialized text is the 50th edit's body;
    `edited_at` reflects the latest amendment; function
    completes within 10 ms on CI (sanity bound — confirms no
    accidentally-quadratic loop). The full chain is preserved
    in IDB.
  - Delete trumps subsequent edits: edit + delete + edit →
    materialized has `deleted: true`, no `edited_at` from
    the post-delete amendment.
  - Authorization: amendment whose `fromUser` differs from
    the original's `fromUser` is silently dropped.
  - Unknown action: `action: 'wat'` is silently dropped;
    `edited_at` not set, `deleted` not set.
  - Orphan: amendment with no matching original → not
    surfaced; later materialization with the original
    present picks it up.
  - **Amendment-to-amendment defense**: amendment A1 targets
    msg X (an original). Amendment A2 targets A1's `msg_id`
    (rather than X). The materializer never sees A1 as an
    "original" (it's in the amendments partition), so A2 has
    no target match → orphan → never surfaces. The
    target-X amendment chain is unaffected by A2's presence.
  - Media delete: original was `type: 'media'`; after
    `action: 'delete'`, materialized has `deleted: true` and
    no `media` reference.
  - Caption edit on a media message: only the body text
    changes; the `media` reference is unchanged.
  - Edit on a pure-media message (no caption / empty body):
    not applied; UI doesn't expose "edit" for these anyway
    but the materializer is defensive.

- `useChatAmendments.test.ts`:
  - `editMessage` calls `sendAmendment` with the right shape.
  - `deleteMessage` calls `sendAmendment` + (when mediaUrl
    given) `storeDelete`.
  - `deleteMessage` returns success even if `storeDelete`
    fails (best-effort; logged not thrown).

- `db.test.ts` (extend) — schema migration:
  - Open DB at the prior version with a `StoredMessage` row
    (text only). Upgrade. Assert the row is still readable
    and its new fields are `undefined`.
  - Write a `StoredMessage` carrying the new
    `inner_type: 'amendment'` + `target_msg_id` + `action`
    fields. Round-trips via `saveMessages` + `loadMessages`.

**Storybook:**

- `ChatMessage`:
  - `Edited` — bubble with `(edited)` tag, hover title
    showing the edit-time delta.
  - `EditedRecently` — same, with a short delta in the
    title.
  - `EditedLongAfter` — same, with "edited 3 weeks later"
    in the title.
  - `Deleted` — `[deleted]` placeholder, correct
    timestamp + author column.
  - `EditingInline` — input field pre-filled with current
    body, Save / Cancel buttons.

- `MessageActions` — open menu for own / others' messages.

- `ChatView`:
  - `WithOneMessageEditing` — chat with several bubbles, one
    of them in inline-edit mode (Save/Cancel visible), the
    others rendering normally. Confirms the "only one
    message edits at a time" invariant: starting an edit on
    one message replaces the editing target rather than
    opening two inputs.

**Playwright e2e (`web/e2e/message-amendments.spec.ts`):**

1. Alice sends "Hi Bob"; Bob sees it.
2. Alice long-presses the message, picks "Edit," changes to
   "Hello Bob," saves. Bob's view updates to "Hello Bob" with
   an `(edited)` tag.
3. Alice deletes the message. Bob's view shows
   `[deleted]` at the same position.
4. Out-of-order: Bob's browser goes offline. Alice sends "X"
   and immediately edits to "X edited." Bob comes back online.
   Bob's first render of the chat shows "X edited" with the
   `(edited)` tag — no flash of "X."
5. Self-copy: Alice opens a second context with the same
   account. The edited and deleted states are reflected on the
   second device.
6. Media delete: Alice sends a photo, then deletes the
   message. Bob's view shows `[deleted]`. A direct fetch of
   `media/{alice}/{ulid}` from a third party (or `curl` in the
   test infrastructure) returns 404.
7. Authorization: a malicious envelope with `from_user` other
   than the original's sender — synthesized into Bob's inbox
   via the test harness — does not modify the original. (This
   is a defensive test for the materializer; no legitimate
   client produces such a payload.)
8. **Edit/delete across compaction**: Alice sends "M". Bob
   receives it. Trigger compaction on Bob's inbox via
   `storeCompact` (test harness has the helper from
   sync-dedup.spec.ts). The message is now in a CBOR archive
   blob, not a live envelope. Alice edits "M" → "M edited."
   Bob's chat view, re-opened, shows "M edited" with the
   `(edited)` tag — the materializer reads originals from the
   archive and amendments from the live inbox uniformly. Alice
   then deletes the message. Bob's view shows `[deleted]`.

**Manual:**

- Edit a message on the phone PWA; observe the edit appear on
  the desktop within the SSE round-trip.
- Delete a message with a photo; observe the desktop client
  drop the photo from the bubble and from any open image
  preview.
