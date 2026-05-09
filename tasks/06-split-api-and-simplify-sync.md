# Split api.ts into transport and protocol; simplify fetchMessages; extract useChatSend

## Spec
`docs/specs/mvp-v0.1.md` "Client sync algorithm" describes the algorithm in numbered steps. The file currently combining all of those concerns is `web/src/lib/api.ts` (~740 lines).

`CONTRIBUTING.md` "Layered architecture" — `lib/` is the lowest layer; nothing within `lib/` is forbidden, but a file mixing unrelated concerns is harder to test and review.

## Current
`web/src/lib/api.ts` mixes three concerns:

1. **Transport / HTTP**: `request`, `APIError`, `NotFoundError`, `NetworkError`, `setOn{DeviceRevoked,Unauthorized}` (see also task 05), `register`, `addDevice`, `listDevices`, `deleteDevice`, `revokeDevice`, `updateProfile`, `resolve`, `storeList`, `storeGet`, `storePresign`, `storeCompact`, `uploadMedia`, `fetchMedia`, `putWithRetry`.
2. **Protocol / messaging**: `conversationId`, `sendTextMessage`, `processEnvelopes`, `fetchArchiveMessages`, `fetchMessages`, `syncMessages`, related types `DecryptedMessage`, `Envelope` import.
3. **Cross-cutting**: `MEDIA_FETCH_TIMEOUT_MS`, fan-in of cursor persistence and fire-and-forget compaction inside `fetchMessages`.

`fetchMessages` (lines ~658–739 in `api.ts`) does five things in sequence: list live with stale-cursor fallback, fetch+parse all live envelopes, run `processEnvelopes` on live, run `fetchArchiveMessages` for archives, persist advanced inbound ratchets, persist cursor, fire-and-forget two compactions. Cyclomatic complexity is high; testing one concern requires staging all of them.

`web/src/hooks/useChat.ts` `sendMessage` (lines ~261–315) and `sendMedia` (~317–385) duplicate ~30 lines: recipient resolution (Saved-Messages branch + `resolve(handle)` else), `sendTextMessage` invocation, post-send `syncMessages`, message merge into local state, `saveMessages` to IDB.

## Change
Three coordinated refactors. Land in this order:

### 6a. Split api.ts
- Move transport/HTTP into `web/src/lib/api.ts` (keep the name; this is what most of the codebase imports from). Trim it to: `APIError`, `NotFoundError`, `NetworkError`, `register`, `addDevice`, `listDevices`, `deleteDevice`, `revokeDevice`, `updateProfile`, `resolve`, `storeList`, `storeGet`, `storePresign`, `storeCompact`, `uploadMedia`, `fetchMedia`, `MEDIA_FETCH_TIMEOUT_MS`, the auth-callback bus (or after task 05).
- Move messaging protocol into `web/src/lib/messaging.ts`: `conversationId`, `DecryptedMessage`, `sendTextMessage`, `processEnvelopes`, `fetchArchiveMessages`, `fetchMessages`, `syncMessages`. Imports `from './api'` for transport; imports `from './megolm-session'` and `from './crypto'` as today.
- Update all callers (`hooks/useChat.ts`, `hooks/useConversations.ts`, `hooks/useSession.ts` if any). The `lib/` rule (no imports from `routes/`, `hooks/`, `components/`) still holds.
- Move test file `api.test.ts` content accordingly: HTTP transport tests stay in `api.test.ts`; protocol tests move to `messaging.test.ts`.

### 6b. Simplify fetchMessages
Refactor `fetchMessages` (now in `messaging.ts`) into smaller named units:

```ts
async function syncLive(token, userId, sharingPrivateKey, sm) → { messages, advancedInbounds, lastKey, prefix }
async function syncArchive(token, userId, sharingPrivateKey, sm, seenMsgIds) → { messages, advancedInbounds }
async function persistInbounds(sm, sessionIds) → void
function triggerCompaction(token, userId, lastLiveKey) → void   // fire-and-forget, no await
```

`fetchMessages` becomes the orchestrator: `syncLive` → `syncArchive(seenMsgIds = live.msgIds)` → `persistInbounds(union)` → `triggerCompaction(...)` → return sorted messages. Each function is independently testable; `triggerCompaction` becomes the only fire-and-forget side effect at the boundary.

### 6c. Extract useChatSend
New hook `web/src/hooks/useChatSend.ts`:

```ts
export function useChatSend(
    handle: string | undefined,
    isSaved: boolean,
    convId: string | null,
    session: Session,
    sessionManager: SessionManager | null,
): {
    sending: boolean;
    sendText: (text: string) => Promise<void>;
    sendMedia: (file: File) => Promise<void>;
}
```

Internally: a private `resolveRecipient()` helper that returns `{ recipientUserId, recipientPubKeyBytes }`; a private `sendAndSync(envelopeText)` that runs the post-send sync+merge+persist sequence and returns the new messages for the caller to merge. `sendMedia` composes with `encryptMedia` + `uploadMedia` and then calls `sendAndSync(JSON.stringify(mediaEnvelope))`.

`useChat.ts` shrinks: it owns only loading, the live-merge state, and the SSE subscription (after task 04 it just calls `subscribe('new_message', resync)`). `sendMessage` / `sendMedia` are forwarded from `useChatSend`.

## Verify
- `make lint test` passes after each sub-task.
- `make web-lint-arch` passes (no layer violations).
- Existing tests in `api.test.ts` keep passing after content moves.
- New tests for `syncLive`, `syncArchive` independently in `messaging.test.ts` (using `MemStore`-equivalent fetch mocks already established).
- Existing `web/e2e/first-conversation.spec.ts`, `media.spec.ts`, `sync-dedup.spec.ts` still pass — these are the regression net for the protocol refactor.
- Bundle size: `pnpm build` should not regress meaningfully (the split is just file-level; tree-shaking is unchanged).
