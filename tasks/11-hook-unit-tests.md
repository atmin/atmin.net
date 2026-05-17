# Add unit tests for hooks

## Spec
`CONTRIBUTING.md` "Testing":
> All non-visual code (lib/, hooks/) must have unit test coverage.

## Current
`web/src/lib/` has thorough unit-test coverage (10 source files, all with colocated `*.test.ts`). `web/src/hooks/` has **none**:

- `useAuroraBackground.ts` (277 lines) — visual, plausibly out of scope; tested via Storybook.
- `useChat.ts` (168 lines) — loads IDB messages, subscribes to inbox updates; delegates send to `useChatSend`.
- `useChatSend.ts` (117 lines) — resolves recipient, calls `sendTextMessage`, triggers post-send sync. Introduced in task 06.
- `useConversations.ts` (115 lines) — orchestrator for the chats list.
- `useDevices.ts` (101 lines) — fetch/list/revoke devices.
- `useInboxSync.ts` (35 lines) — owns the SSE connection, triggers `syncAndPublish` on mount and on `new_message` events.
- `useLogin.ts` (88 lines) — derive keys, add device, save session.
- `useMedia.ts` (138 lines) — concurrent media fetch/decrypt with abort.
- `useRegister.ts` (72 lines) — generate mnemonic, register, save session.
- `useSession.ts` (144 lines) — session boot, WASM/megolm init, logout, auth events.
- `useSWUpdate.ts` (23 lines) — service-worker update toast (small, but uncovered).

Several hooks are pure orchestrators around well-tested `lib/` functions; their tests should focus on **the orchestration**, not re-test the underlying primitives.

## Change
Add `*.test.ts` colocated with each hook. Use `@testing-library/react`'s `renderHook` for setup; mock `lib/` modules at the import boundary with Vitest's `vi.mock`. Suggested per-hook focus (one or two tests each is enough — full coverage is gold-plating):

- `useSession.test.ts`:
  - On mount, calls `loadSession` and exposes the result; `loading` flips to false.
  - On `handleLogin`, sets the session.
  - On `handleLogout`, clears local state and calls `deleteDevice` once (best-effort) followed by `clearSession`.
  - StrictMode double-mount does not spawn two concurrent `createSessionManager` calls (regression for the existing `cancelled` flag).
  - Emitting `onAuthEvent('device_revoked')` triggers the same teardown as `handleLogout`.
  - Emitting `onAuthEvent('unauthorized')` clears session state and calls `clearToken`.
  - After unmount the `onAuthEvent` listeners are removed (no stale callback fires).
- `useLogin.test.ts`:
  - Happy path: resolves handle, derives keys, calls `addDevice`, saves session, navigates to `/`.
  - Failure: `addDevice` rejects → `error` is set, `loading` stays false.
- `useRegister.test.ts`:
  - Generates a 12-word mnemonic on first render (does not regenerate on re-render — guarded by the `if (!mnemonic)` check).
  - `handleRegister` calls `register`, saves session, advances `step` to `done`.
- `useDevices.test.ts`:
  - On mount, fetches devices via `listDevices`.
  - `handleRevoke` with valid mnemonic input calls `revokeDevice` and refreshes; with bad mnemonic, sets `revokeError` and does not call `revokeDevice`.
- `useChatSend.test.ts`:
  - `resolveRecipient`: Saved Messages path returns own userId + sharingPublicKeyBytes without calling `resolve`; DM path calls `resolve(handle)` and decodes the returned key.
  - Sending while `sending=true` is a no-op (guard fires before `resolveRecipient`).
  - No sessionManager → `sendText` and `sendMedia` return immediately without calling `sendTextMessage`.
  - Happy path: `sendText` calls `sendTextMessage` then `syncAndPublish`; `sendMedia` additionally calls `encryptMedia` + `uploadMedia` before the same pair.
- `useChat.test.ts`:
  - Loads cached IDB messages first, then re-renders on inbox update notification.
  - `parseMediaEnvelope` returns null for plain text, parses well-formed media JSON, returns null for malformed JSON. (Not exported — test indirectly via `toMessages`.)
- `useInboxSync.test.ts`:
  - On mount with a valid session + sessionManager, calls `syncAndPublish` once immediately.
  - A `new_message` SSE event triggers a second `syncAndPublish` call.
  - On unmount, the EventSource is closed (no further calls after cleanup).
- `useMedia.test.ts`:
  - Fetches and decrypts each file in `files`; aborts in-flight requests when files prop changes; revokes ObjectURLs on unmount.
  - `retry(url)` re-fetches a previously failed URL.
  - Status transitions: `loading` → `ready` (image), `corrupt` (decrypt fail), `unavailable` (404), `network-error` (5xx).
- `useConversations.test.ts`:
  - Renders cached conversations from IDB; `serverOk` flips after `/healthz` resolves.
- `useSWUpdate.test.ts`: smoke test only — verify `needRefresh`/`onUpdate`/`onDismiss` plumbing.

For `useAuroraBackground`, leave uncovered (visual, owned by Storybook). Add a `// covered by Storybook` comment at the top of the file.

## Verify
- `make web-test` runs and passes; new files appear in the test report.
- `grep -L "from 'vitest'" web/src/hooks/*.ts` lists only `useAuroraBackground.ts` (the documented exception).
- Update `CONTRIBUTING.md` "Testing" if you decide to formalise the Aurora exception (the file already says "All non-visual code"; clarify that Aurora is visual).
