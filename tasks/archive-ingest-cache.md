# Stop re-downloading already-ingested message archives on refresh

On every page load the client re-lists, re-downloads, and re-decrypts the
**entire** `inbox/{uid}/archive/` history, even though those messages are
already materialized in IndexedDB. On slow connections this is the dominant
cold-start cost. Eliminate the redundant download + decrypt; correctness must
not regress (no dropped or permanently-undecryptable messages).

## Spec

The behaviour we want, stated as an invariant the implementation must hold:

> On a refresh, an archive object is downloaded and decrypted **only if** it
> may carry a message that is not yet durably materialized in IndexedDB. An
> archive whose every message is already stored is not fetched again.

Two corollaries that are non-negotiable (they are the correctness boundary):

1. **Skipping a download must never lose a message.** An archive may be marked
   "ingested" (safe to skip next time) only once *every* envelope it carries is
   either durably stored or is a non-message (e.g. `megolm.key_share`).
2. **A recoverable skip is not ingestion.** If an envelope was skipped because
   its Megolm session is not yet known (the key may arrive later via the backup
   chain — [ADR-0012](../docs/decisions/adr-0012-backup-secret-rotation.md),
   invariants [I6](../docs/scenarios/invariants/i6-key-restore.md)/I9), the
   archive is **not** ingested and will be re-fetched on a later sync, so the
   message materializes once the key is restored. This is the subtlety that
   makes a naïve "remember which keys we downloaded" cache wrong.

No protocol, server, or S3-layout change. This is a client-only caching fix.

## Current

- [messaging.ts:386-441](../web/src/lib/messaging.ts#L386-L441) — `syncArchive()`
  lists `inbox/{uid}/archive/` using a stored high-water cursor
  ([loadSyncCursor](../web/src/lib/db.ts#L669-L678)), but **falls back to a full
  re-list** when that cursor is stale (lines 402-405), then **downloads and
  CBOR-decodes every listed archive** (lines 416-426) and Megolm-decrypts every
  envelope via `processEnvelopes`.
- The cursor goes stale **routinely**: compaction (`POST /v1/store/compact`)
  deletes/renames the archive object the cursor points at, so the fallback —
  full cold re-download — is the common path, not the exception.
- [processEnvelopes:291-326](../web/src/lib/messaging.ts#L291-L326) already
  dedups by `seenMsgIds` and **skips unknown-session envelopes** (line 301-306,
  `continue` after a `console.warn`) — but `seenMsgIds` is seeded only from the
  *current* live sync ([syncLive](../web/src/lib/messaging.ts#L332-L384) passes
  `new Set()`), **not** from messages already in IDB. So previously-stored
  archive messages get re-decrypted every time.
- Decrypted messages are persisted to the `messages` store
  ([db.ts:126-157](../web/src/lib/db.ts#L126-L157)); the renderer reads only
  from IDB ([useChat.ts:195](../web/src/hooks/useChat.ts#L195)) — so *display*
  is already cached. The waste is entirely in the **sync** path.
- IDB schema is at `DB_VERSION = 7` ([db.ts:18](../web/src/lib/db.ts#L18)); the
  `sync_cursors` store holds the (fragile) archive cursor.

## Change

### 1. New IDB store: `ingested_archives` (DB_VERSION 7 → 8)

[db.ts](../web/src/lib/db.ts) — bump `DB_VERSION` to 8 and, in
`onupgradeneeded`, create a store keyed by the archive's full S3 key:

```ts
export interface StoredIngestedArchive {
    key: string; // full S3 key, e.g. "inbox/U1/archive/2026-06-14-01HW…"
    ingestedAt: number; // ms epoch — for optional pruning, not correctness
}
// keyPath: 'key'. The key already contains {uid}, so no userId namespacing.
```

Add `markArchiveIngested(key)`, and `loadIngestedArchiveKeys(): Promise<Set<string>>`
(read all keys, return a Set). Mirror the existing helper style in `db.ts`.

The store is empty after the upgrade, so the **first** post-upgrade sync
re-downloads the full archive once and populates the set — a one-time cost,
worth calling out in the PR.

### 2. Rewrite `syncArchive` to process **per-archive** and skip ingested keys

Restructure so the ingested decision is local to each archive (today the code
flattens all archives into one `allEnvelopes` list, which makes a per-archive
decision impossible). `syncArchive` must **not** mark anything itself — it only
*decides* which keys are fully materialized and returns them; the actual
`markArchiveIngested` happens after persistence (see "Marking layer" below):

```
ingested = await loadIngestedArchiveKeys()
keys = full archive listing            // see §3 — page through; do NOT rely on
                                        // the stale high-water cursor
ingestedCandidates = []
for key in keys:
    if ingested.has(key): continue      // ← the bandwidth win: no GET at all
    try:
        blob = await storeGet(token, key)
        envs = cborDecode(blob)
    catch:
        continue                        // download/decode failed → NOT a
                                        // candidate; re-fetched next sync
    result = await processEnvelopes(envs, …, seenMsgIds, …)
    // candidate ONLY if fully materialized (corollary 1 + 2)
    if result.recoverableSkips === 0:
        ingestedCandidates.push(key)
    messages.push(...result.messages)
return { messages, advancedInbounds, ingestedCandidates }
```

`processEnvelopes` must report whether it skipped any envelope for a
**recoverable** reason (unknown Megolm session — [messaging.ts:301-306](../web/src/lib/messaging.ts#L301-L306)).
Add a `recoverableSkips: number` (or a `Set<string>` of pending session IDs) to
its return type. A *decrypt failure* on a known session
([catch at 321-323](../web/src/lib/messaging.ts#L321-L323)) is the I6/I9
"belt-and-suspenders" path and is **not** recoverable-by-waiting → it should not
block ingestion (the message is recovered via the key-backup chain, not via a
re-download). It must **not** count toward `recoverableSkips`.

**Marking layer — mark after persist, not inside `syncArchive`.** This is the
crux of corollary 1, and it constrains *where* the mark happens.
[`fetchMessages`](../web/src/lib/messaging.ts#L520-L572) does **not** persist —
it returns messages, and the caller [`syncAndPublish`](../web/src/lib/inbox-sync.ts#L43-L78)
is what calls [`saveMessages`](../web/src/lib/db.ts#L338) (and bails on its
failure). So marking inside `syncArchive`'s loop would mark archives ingested
*before* persistence, and even when persistence fails — the "skipped forever
with messages missing" bug. Instead, thread `ingestedCandidates` up through
`fetchMessages`'s return value to `syncAndPublish`, and call
`markArchiveIngested(key)` for each candidate **only after** `saveMessages`
resolves successfully. If `saveMessages` throws (the early `return` at
[inbox-sync.ts:65-68](../web/src/lib/inbox-sync.ts#L65-L68)), mark nothing — the
archives are re-fetched next sync.

### 3. Drop the archive high-water cursor; list the full prefix

The `sync_cursors` archive entry was the source of the staleness bug and is no
longer the source of truth — the `ingested_archives` set is. List the full
`inbox/{uid}/archive/` prefix and filter against the set.

- **Page through the full listing — no server change needed.** The server
  already returns `next_cursor` ([routes.rs:159-164](../server/src/routes.rs#L159-L164):
  empty string = last page), and the TS `StoreListResponse` already carries it
  ([api.ts:160-163](../web/src/lib/api.ts#L160-L163)). `storeList`
  ([api.ts:352-360](../web/src/lib/api.ts#L352-L360)) takes a `cursor`
  (S3 `start-after` semantics) but exposes only a single call. For a complete
  listing, loop: pass `next_cursor` back as the `cursor` until it comes back
  empty, accumulating `keys`. This is purely client-side.
- Leave `syncLive`'s cursor as-is — live sync is already correct and efficient.
- Leftover `sync_cursors` archive rows are harmless; no migration needed to
  remove them.

### 4. Seed `seenMsgIds` from IDB (the CPU win, and a correctness backstop)

In `fetchMessages` ([messaging.ts:520-572](../web/src/lib/messaging.ts#L520-L572)),
before syncing, load the set of msg_ids already in the `messages` store for this
user and seed `seenMsgIds` with it. Add a keys-only reader to `db.ts`
(`loadMessageIds(userId): Promise<Set<string>>` via the `userId` index, reading
keys only — do not deserialize full messages). This:

- skips Megolm decryption of any already-stored message even inside a freshly
  **compacted/merged** archive (a new key we *do* download, which re-includes
  old messages); and
- guarantees the per-archive "fully materialized" check is meaningful — an
  envelope whose msg_id is already stored counts as materialized, not as a skip.

## Correctness notes (read before implementing)

- The ordering of §1+§2 matters: **store the messages, then mark the archive
  ingested.** If marking happened first and the message write failed, the
  archive would be skipped forever with messages missing. Note `fetchMessages`
  does **not** persist — `saveMessages` is called one layer up in
  `syncAndPublish` ([inbox-sync.ts:43-78](../web/src/lib/inbox-sync.ts#L43-L78)),
  so the mark must happen there, after `saveMessages` resolves. See the
  "Marking layer" paragraph in §2.
- Stale entries accumulate in `ingested_archives` (compaction deletes old keys;
  their set entries never match a future listing again). They are tiny strings;
  pruning is optional. If added: drop set entries not present in the latest full
  listing — but only after a *successful, complete* listing, never on a partial
  one.
- This optimization sits **on top of** the existing msg_id dedup, not instead of
  it. If the ingested-set is ever wrong (e.g. cleared), correctness is preserved
  by §4 — the worst case degrades to today's behaviour (re-download), never to
  lost messages.

## Verify

- `make lint test` — unit tests pass; architecture lint passes (new logic lives
  in `lib/`, not `components/`).
- New unit tests in `messaging.test.ts` / `db.test.ts`:
  - An archive already in `ingested_archives` is **not** fetched (`storeGet` not
    called for its key); a new archive **is**.
  - An archive containing an unknown-session envelope is **not** marked ingested
    and **is** re-fetched on the next sync; once the session is known, the
    message materializes and the archive then becomes ingested.
  - `seenMsgIds` seeded from IDB suppresses re-decryption of stored msg_ids
    inside a re-downloaded (merged) archive.
  - Full-listing pagination: an archive prefix spanning multiple list pages is
    fully enumerated.
- Invariant coverage: extend the existing key-restore invariant
  ([I6](../docs/scenarios/invariants/i6-key-restore.md)/I9) test rather than
  adding a new invariant — assert that archive-ingest caching does **not**
  prevent a late-arriving key from materializing a previously-undecryptable
  archived message. This is the corollary-2 regression guard.
- `pnpm tsc && pnpm build` (the gate skips these — see project setup).
- Manual on a real device / throttled network:
  1. Cold load a chat with several days of archived history → full download once.
  2. Refresh → archive objects are **not** re-downloaded (DevTools Network shows
     no `store/object` GETs for already-ingested archive keys); history still
     renders fully and correctly.
  3. Trigger a compaction, then refresh → only the new merged archive is
     fetched; no duplicate messages; no re-decrypt of old messages (no Megolm
     decrypt cost spike).

## Out of scope

- **Lazy media download / in-chat previews** — tracked separately; opening a
  chat still eagerly downloads full-res media, which is the other half of the
  slow-chat-open problem.
- **Two-way infinite scroll / archive pagination in the UI** — see
  [message-virtualization.md](message-virtualization.md) "Out of scope".
- **Server-side listing changes.** None needed — `next_cursor` is already
  surfaced (§3); this task is entirely client-side.
