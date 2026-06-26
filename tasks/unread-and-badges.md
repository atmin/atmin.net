# Unread tracking + badges + "New" divider

> "How do I know I have new messages?" Four deliverables: an app-icon badge
> (installed PWA) with the count of chats that have unread, a per-row unread
> **message** count on the chats list, a Slack-style `── New ──` divider inside a
> conversation, and **cross-device sync** of read position so catching up on one
> device clears the others. All driven by one piece of state — a per-conversation
> `lastReadTimestamp` — held locally in IDB and synced as a zero-knowledge
> encrypted blob the server can't read.

## Three decisive constraints

**1. Unread is local self-state — not a read receipt.** It answers "what haven't
*I* seen," never "tell the *other* person I saw it." No envelope, no peer signal —
so it does **not** touch the read-receipts non-goal ([vision.md](../docs/vision.md)
Non-goals).

**2. Cross-device sync is zero-knowledge, and needs no server logic.** Read markers
ride the `contacts.json` rails: one `users/{uid}/read-markers.json` blob, AES-256-GCM
under the **backup key**, presigned PUT + authenticated GET. The server stores
opaque ciphertext — it can't see which chats exist or where you've read. Two
properties make this near-free:
- **Single blob, not per-conversation keys.** A `read-markers/{conversationId}`
  layout would leak the social graph (`dm:U1:U2`) in object names. One blob keeps
  the same metadata class as contacts.
- **Monotone merge = a CRDT.** `lastReadTimestamp` only ever increases, so the
  merge is per-conversation `max()`. GET → merge → PUT; if two devices race, the
  loser re-GETs and re-merges and it **always** converges — no mutex, no
  server-side conflict logic. The watermark is the **message's own timestamp**, so
  merging is immune to device clock skew.

**3. The icon badge is "fresh as of last open," by design.** `setAppBadge(n)` only
runs while our code runs; app closed → SSE is down ([useInboxSync.ts](../web/src/hooks/useInboxSync.ts))
→ the badge is frozen at its last foreground value. Updating it *while closed*
needs a background wake-up, which [ADR-0015](../docs/decisions/adr-0015-web-push.md)
deliberately dropped for the native-apps track. **Scope: set/clear on every
foreground sync and on mark-read.** Buzzes-while-closed is out of scope (native).

## Scope (this round)

| Deliverable | Source | Semantics |
|---|---|---|
| **App-icon badge** | `navigator.setAppBadge` | Count of **conversations with ≥1 unread**. Feature-detect; no-op where unsupported (Firefox). 0 → `clearAppBadge()`. |
| **Chats-row badge** | `ChatsView` row | Per-chat unread **message** count (incoming only). |
| **`── New ──` divider** | `ChatView` render loop | Before the first incoming message past the boundary; boundary frozen on open. |
| **Cross-device sync** | `read-markers.json` | Encrypted blob, monotone `max()` merge; GET-merge on foreground, debounced PUT on mark-read. |

Unread counts **incoming** messages only (`fromUser !== me` / `sent === false`).
Own sends and self-chat never count.

## Current

- **Message model**: `Message { id, text, timestamp: Date, sent, … }`
  ([useChat.ts:18-30](../web/src/hooks/useChat.ts#L18-L30)); stored as
  `StoredMessage { id, userId, conversationId, fromUser, timestamp(ms), … }`
  ([db.ts:58-66](../web/src/lib/db.ts#L58-L66)).
- **Conversations store** (IDB `atmin` v9): `StoredConversation { conversationId,
  lastMessageText, lastMessageTimestamp, messageCount, lastMessageDeleted }`
  ([db.ts:68-78](../web/src/lib/db.ts#L68-L78)). **No `lastRead` / unread field.**
- **Chats list**: [chats.tsx](../web/src/routes/chats.tsx) →
  [ChatsView.tsx](../web/src/components/ChatsView.tsx); backed by
  [useConversations.ts](../web/src/hooks/useConversations.ts), re-reads IDB on
  `onInboxUpdated`.
- **ChatView divider loop**: [ChatView.tsx:297-341](../web/src/components/ChatView.tsx#L297-L341)
  — `newDay` per message; same insertion point a `New` divider reuses.
- **Sync fan-out**: `syncAndPublish → saveMessages → onInboxUpdated`
  ([inbox-sync.ts](../web/src/lib/inbox-sync.ts)); SSE trigger in
  [useInboxSync.ts](../web/src/hooks/useInboxSync.ts). Foreground-only.
- **Encrypted-blob plumbing to mirror** — `contacts.json` is the template:
  - Server presign is **generic**: `POST /v1/store/presign` →
    `authorize_key_write` already permits any `users/{uid}/*` key
    ([paths.rs:90-97](../server/src/paths.rs#L90-L97),
    [routes.rs:290-329](../server/src/routes.rs#L290-L329)). **No server change.**
  - Client lib [contact-backup.ts](../web/src/lib/contact-backup.ts)
    (`uploadContacts`/`restoreContacts`) — encrypt with `backupKey` via
    `backupEncrypt`/`backupDecrypt` ([crypto.ts:403-427](../web/src/lib/crypto.ts#L403-L427)),
    wrap in `KeyBackupEnvelopeV2 {v, iv, ciphertext}`
    ([key-backup-envelope.ts](../web/src/lib/key-backup-envelope.ts)), presign +
    `putWithRetry`, GET via `storeGet` ([api.ts:383-430](../web/src/lib/api.ts#L383-L430)).
  - **Backup key** is on-device: `Session.backupKey` ([useSession.ts:56](../web/src/hooks/useSession.ts#L56)).
  - The envelope's `v` (`key_version`) + chain-walk give **rotation survival for
    free** if mirrored from `restoreContacts`.
- **PWA**: vite-plugin-pwa, `display: standalone`, installable; Badging API unused.

## Change

**Doc / decision**

1. **ADR (tight)** — the read-marker sync model: backup-key-encrypted single blob,
   monotone per-conversation `max()` merge (CRDT, eventual consistency, no server
   logic), watermark = message timestamp. Record what it was chosen *over*:
   per-conversation objects (graph leak), server-side read state (breaks
   zero-knowledge), a locking scheme (needless given monotonicity). Crosses the
   zero-knowledge boundary + adds an S3 object → ADR-worthy; keep it short (mind
   ADR proliferation — see doc-consolidation discipline).
2. **Spec + layout** — add the `users/{uid}/read-markers.json` row to
   [mvp-v0.1.md](../docs/specs/mvp-v0.1.md) storage layout and the S3-layout table
   in [CONTRIBUTING.md](../CONTRIBUTING.md) (owner: client, presigned PUT,
   AES-256-GCM with backup key).

**Local layer (instant, offline)**

3. **IDB v9 → v10**: add `lastReadTimestamp` to `StoredConversation`; upgrade
   callback **backfills existing rows to `lastMessageTimestamp`** (never flood a
   returning user with "everything is new"). Add `markConversationRead` +
   `unreadCount` derivation in [db.ts](../web/src/lib/db.ts). IDB stays the source
   of truth for rendering; the blob is the convergence layer.
4. **Chats-row badge**: surface per-conversation unread via
   [useConversations.ts](../web/src/hooks/useConversations.ts) (hook); render a
   Konsta badge in [ChatsView.tsx](../web/src/components/ChatsView.tsx) (component —
   no `useEffect`).
5. **App-icon badge**: a `useAppBadge` hook (or fold into `useInboxSync`) that, on
   `onInboxUpdated` and on mark-read, computes chats-with-unread and calls
   `setAppBadge`/`clearAppBadge` behind a `'setAppBadge' in navigator` guard.
   Side-effect → **hooks layer**.
6. **`── New ──` divider**: capture `lastReadTimestamp` **once on open** in
   [useChat.ts](../web/src/hooks/useChat.ts) (frozen boundary — a sync arriving
   while open affects the *next* open, not the live line); pure boundary test in
   the [ChatView.tsx](../web/src/components/ChatView.tsx) loop next to `newDay`.
   Show only if ≥1 incoming message is past it.
7. **Mark read**: advance `lastReadTimestamp` on open; keep advancing while focused
   + scrolled near bottom (v1: on open + on each in-view sync; scroll-precise is an
   optional refinement).

**Sync layer (cross-device, zero-knowledge)**

8. **`read-markers.ts`** mirroring `contact-backup.ts`: `uploadReadMarkers` /
   `restoreReadMarkers` over `path.readMarkers(uid)` = `users/{uid}/read-markers.json`,
   same `backupKey` + `KeyBackupEnvelopeV2` + chain-walk. Blob shape:
   `{ v: 1, markers: { [conversationId]: lastReadMs } }`.
9. **Merge**: `merge(local, remote) → per-key max()` (pure, in lib). On foreground /
   inbox sync, GET → merge into IDB → if local advanced any key beyond remote,
   re-encrypt + PUT. On race/conflict, re-GET + re-merge (idempotent, converges).
10. **PUT cadence**: debounce/coalesce on mark-read (e.g. on `visibilitychange`/blur
    or a few-second debounce) — never a PUT per message. Offline → local works;
    flush on reconnect.

**Safety**

11. Clear `lastReadTimestamp` with the rest of local state on account-switch/wipe
    (I11) — no cross-account leak of read position.

## Verify

- **Scenario + e2e**: new [docs/scenarios/unread-messages.md](../docs/scenarios/)
  + `web/e2e/unread.spec.ts` — peer sends N while chat closed → row badge `N`,
  icon reflects the chat → open → `── New ──` above first unseen → leave/reopen →
  divider gone, badge cleared. **Multi-device**: read on device A → device B's next
  foreground sync shows it read (no fake "new"). Document the closed-app
  icon-staleness limitation in the prose (cites ADR-0015) — behaviour, not bug.
- **Unit (lib)**: `merge()` commutative + idempotent + converges to per-key max;
  `unreadCount` derivation; v10 upgrade backfill marks existing history read;
  incoming-only filter; rotation survival (decrypt an older-`v` blob via chain).
- **Storybook**: `ChatsView` mixed read/unread rows; `ChatView` with a `New`
  divider mid-thread.
- **Manual / real device** (the bar for done): install the PWA on iPhone (Safari
  16.1+) → confirm the icon badge appears and clears on read, and is
  stale-until-open. Two real devices → read on one, confirm the other catches up.

## Deferred / follow-on

- **Closed-app / push-driven badge** — background wake-up to refresh the icon while
  the app is closed. Native-apps track per [ADR-0015](../docs/decisions/adr-0015-web-push.md).
