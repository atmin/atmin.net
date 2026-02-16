# Persist sync cursor for incremental inbox fetching

## Spec
`docs/specs/mvp-v0.1.md` line ~192: "Persist cursor and msg_id de-dup set." Client should resume from stored cursor on subsequent syncs instead of re-fetching everything.

## Current
`web/src/lib/api.ts` `fetchMessages()` calls `storeList(token, inbox/{userId}/live/)` without a cursor — fetches all live envelopes every time. The `storeList` function accepts a `cursor` parameter but it's never used by callers.

## Change
1. In `web/src/lib/db.ts`: add a `sync_cursors` store (or key-value in existing `keys` store) to persist `{prefix, cursor}` pairs.
2. In `api.ts` `fetchMessages()`: load the stored cursor for `inbox/{userId}/live/`, pass it to `storeList`, and update the cursor after processing.
3. On first sync (no stored cursor), fetch everything as today. On subsequent syncs, only fetch new objects.
4. Handle edge case: if cursor is stale (object deleted by compaction), fall back to full fetch.

## Verify
- `cd web && npm test` passes
- Manual: send several messages, close and reopen — network tab shows only new objects fetched
