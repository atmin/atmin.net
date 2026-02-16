# Handle 403 device_revoked with self-wipe

## Spec
`docs/specs/mvp-v0.1.md` line ~422: "When a client receives 403 device_revoked, it must wipe all local state (IndexedDB keys, session keys, chat history, device token) and return to the welcome screen."

## Current
`web/src/lib/api.ts` throws `APIError` with `status` and `code` fields, but no caller checks for `device_revoked`. The revoked device keeps operating with stale state.

## Change
1. Add a global error handler or wrapper. Options:
   a. Wrap `apiFetch()` in `api.ts` to check `if (error.code === 'device_revoked')` and trigger wipe, OR
   b. Add an interceptor pattern where hooks can register a revocation callback.
2. On `device_revoked`: call `clearSession()` from `auth.ts`, call `deleteDatabase()` from `db.ts` (or `indexedDB.deleteDatabase('atmin')`), then redirect to `/`.
3. The `useSession` hook in `web/src/hooks/useSession.ts` already manages session state — it's a natural place to expose the wipe trigger and have it set `session = null`.

## Verify
- `cd web && npx tsc --noEmit` passes
- `cd web && npm test` passes
- Manual or e2e: revoke a device via second device, confirm first device returns to welcome screen on next API call
