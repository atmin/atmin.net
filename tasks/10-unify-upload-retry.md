# Unify upload retry behaviour across all presigned PUT uploads

## Spec
`docs/specs/mvp-v0.1.md` "Upload reliability":
> PUT failure: client retries once on network/5xx; second failure surfaces an inline "Upload failed — retry" control. Presigned URL expiry: client re-presigns and retries. `POST /v1/send` is idempotent by `msg_id`; the client retries the send leg independently of the PUT leg.

The spec lives under "Media" but the underlying contract — "presigned PUT uploads retry once on transient failure" — applies to every presigned upload, not just media.

## Current
Three different upload paths, three different behaviours:

1. **`web/src/lib/api.ts` `uploadMedia` → `putWithRetry`**: matches the spec — one retry on network or 5xx, terminal on 4xx, supports `AbortSignal`.
2. **`web/src/lib/key-backup.ts` `backupSessionKey`**: bare `await fetch(presigned_url, { method: 'PUT', body })`. No retry, no error check (the response status is not even inspected — a 5xx silently "succeeds"), no abort.
3. **`web/src/lib/contact-backup.ts` `uploadContacts`**: same as #2 — bare `fetch`, no retry, no status check.

The two unchecked uploads can silently lose data — e.g. a transient 503 from S3 leaves us thinking the contact list / key backup was uploaded when it wasn't.

## Change
1. Promote `putWithRetry` from a private helper inside `api.ts` to an exported utility (move to `web/src/lib/api.ts` top-level export, or to `paths.ts`'s sibling — your call). Keep its existing signature: `putWithRetry(url, body, abort?)`.
2. In `web/src/lib/key-backup.ts` `backupSessionKey`, replace `await fetch(...)` with `await putWithRetry(presigned_url, blobBytes)`. Let errors propagate so `useSession`'s existing `.catch((err) => console.error('Key backup failed:', err))` handles them.
3. In `web/src/lib/contact-backup.ts` `uploadContacts`, same change. `useChat` and `useConversations` already wrap calls in `.catch(err => console.error(...))`.
4. While you're there, sanity-check `putWithRetry` itself: confirm it surfaces a meaningful `APIError` on terminal 4xx, and that `lastErr` is never `undefined` (the `for (let attempt = 0; attempt < 2; attempt++)` body always assigns `lastErr` before re-loop). Add a unit test if one doesn't exist.

## Verify
- `make lint test` passes.
- New unit tests in `web/src/lib/key-backup.test.ts` (create if missing) and `web/src/lib/contact-backup.test.ts`: a stubbed `fetch` returning 503 once then 200 results in two calls and a resolved promise; a stubbed `fetch` returning 503 twice rejects.
- `grep -n "method: 'PUT'" web/src/lib --include='*.ts' -r` returns hits only inside `putWithRetry`.
- Existing e2e `web/e2e/media.spec.ts` still passes (it exercises `uploadMedia`, which already uses `putWithRetry`).
