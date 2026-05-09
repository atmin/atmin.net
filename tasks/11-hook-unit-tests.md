# Add unit tests for hooks

## Spec
`CONTRIBUTING.md` "Testing":
> All non-visual code (lib/, hooks/) must have unit test coverage.

## Current
`web/src/lib/` has thorough unit-test coverage (10 source files, all with colocated `*.test.ts`). `web/src/hooks/` has **none**:

- `useAuroraBackground.ts` (277 lines) — visual, plausibly out of scope; tested via Storybook.
- `useChat.ts` (396 lines) — orchestrator for chat state, send, sync, SSE.
- `useConversations.ts` (142 lines) — orchestrator for the chats list.
- `useDevices.ts` (101 lines) — fetch/list/revoke devices.
- `useLogin.ts` (88 lines) — derive keys, add device, save session.
- `useMedia.ts` (138 lines) — concurrent media fetch/decrypt with abort.
- `useRegister.ts` (77 lines) — generate mnemonic, register, save session.
- `useSession.ts` (135 lines) — session boot, WASM/megolm init, logout, auth events.
- `useSWUpdate.ts` (23 lines) — service-worker update toast (small, but uncovered).

Several hooks are pure orchestrators around well-tested `lib/` functions; their tests should focus on **the orchestration**, not re-test the underlying primitives.

## Change
Add `*.test.ts` colocated with each hook. Use `@testing-library/react`'s `renderHook` for setup; mock `lib/` modules at the import boundary with Vitest's `vi.mock`. Suggested per-hook focus (one or two tests each is enough — full coverage is gold-plating):

- `useSession.test.ts`:
  - On mount, calls `loadSession` and exposes the result; `loading` flips to false.
  - On `handleLogin`, sets the session.
  - On `handleLogout`, clears local state and calls `deleteDevice` once (best-effort) followed by `clearSession`.
  - StrictMode double-mount does not spawn two concurrent `createSessionManager` calls (regression for the existing `cancelled` flag).
- `useLogin.test.ts`:
  - Happy path: resolves handle, derives keys, calls `addDevice`, saves session, navigates to `/`.
  - Failure: `addDevice` rejects → `error` is set, `loading` stays false.
- `useRegister.test.ts`:
  - Generates a 12-word mnemonic on first render (does not regenerate on re-render — guarded by the `if (!mnemonic)` check).
  - `handleRegister` calls `register`, saves session, advances `step` to `done`.
- `useDevices.test.ts`:
  - On mount, fetches devices via `listDevices`.
  - `handleRevoke` with valid mnemonic input calls `revokeDevice` and refreshes; with bad mnemonic, sets `revokeError` and does not call `revokeDevice`.
- `useChat.test.ts`:
  - Loads cached IDB messages first, then merges synced messages on top.
  - `parseMediaEnvelope` returns null for plain text, parses well-formed media JSON, returns null for malformed JSON. (This is not exported — either export it, or test indirectly via `toMessages`.)
  - Sending while `sending=true` is a no-op.
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
