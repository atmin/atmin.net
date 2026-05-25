# Credential overhaul 4/5 — "Change password" settings UI

Part of the credential-overhaul task group:

1. [credential-registration](credential-registration.md) — registration UI + Argon2id + salt
2. [credential-rotate-endpoint](credential-rotate-endpoint.md) — server `POST /v1/rotate-keys`
3. [credential-backup-chain](credential-backup-chain.md) — `key_chain.json` + envelope versioning
4. **credential-rotate-ui** (this file) — settings UI for "change password"
5. [credential-multi-device-cutoff](credential-multi-device-cutoff.md) — handle `401 key_version_stale`

## Motivation

The visible end of the credential overhaul: a "Change password"
panel in Settings that lets the user atomically rotate their
credential and all derived keys. This is the task that wires
together everything tasks 1, 2, and 3 produced.

Depends on tasks 1, 2, and 3. Required to ship before task 5
(other-device cutoff handling) has anything to test against.

Specs: [ADR-0012](../docs/decisions/adr-0012-backup-secret-rotation.md),
[mvp-v0.1.md#rotate-keys](../docs/specs/mvp-v0.1.md#rotate-keys),
[mvp-v0.1.md#backup-secret](../docs/specs/mvp-v0.1.md#backup-secret).

## Current state

- [settings.tsx](../web/src/routes/settings.tsx) shows profile +
  device list. No credential controls.
- Tasks 1–3 have shipped (assumed). The codebase has:
  - [crypto.ts](../web/src/lib/crypto.ts) `argonStretch`,
    `signContinuity`, `generateSalt`, `DEFAULT_KDF`.
  - [api.ts](../web/src/lib/api.ts) `rotateKeys` wrapper.
  - [key-chain.ts](../web/src/lib/key-chain.ts) `buildChainLink`,
    `appendChainLink`.
  - `PasswordField` + `PasswordStrengthMeter` from task 1.

## Architecture constraints

- Hook (`useRotateKeys`) owns the orchestration. Settings route
  stays a thin orchestrator. The change-password panel is a
  presentational component.
- The rotating client **must** write `key_chain.json` before
  `POST /v1/rotate-keys` (per [ADR-0012](../docs/decisions/adr-0012-backup-secret-rotation.md)
  *Rotate keys*). The hook enforces the order.
- The current password is needed to compute the continuity
  signature — the auth private key is not persisted, only derivable
  from the credential. Re-entry is a natural rotation gate, not
  separate UX work.

## Change

### 1. New hook: `useRotateKeys`

[web/src/hooks/useRotateKeys.ts](../web/src/hooks/useRotateKeys.ts):

```ts
export type RotateStep =
    | 'enter'
    | 'deriving-old'    // ~3-4 s — Argon2id on current password
    | 'deriving-new'    // ~3-4 s — Argon2id on new password
    | 'writing-chain'
    | 'rotating'
    | 'done';

export interface RotateState {
    step: RotateStep;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    error: string | null;
    setCurrent: (v: string) => void;
    setNew: (v: string) => void;
    setConfirm: (v: string) => void;
    submit: () => Promise<void>;
}

export function useRotateKeys(
    session: Session,
    profile: { salt: string; kdf: KdfParams; keyVersion: number },
    onSuccess: (next: Session) => void,
): RotateState;
```

The `submit` flow:

1. **deriving-old**: `argonStretch(currentPassword, profile.salt, profile.kdf)`
   → 16-byte secret → `deriveKeys(secret)` → `oldAuth.privateKey`,
   `oldBackupKey`. If derivation succeeds but `oldAuth.publicKeyBytes`
   does not match `profile.auth_public_key`, the entered current
   password is wrong → `error = "Current password is incorrect"` →
   step `enter`.
2. **deriving-new**: `generateSalt()` → `argonStretch(newPassword, newSalt, DEFAULT_KDF)`
   → `deriveKeys(newSecret)` → new auth/sharing/backup keys.
3. **writing-chain**: `buildChainLink(oldKv, newKv, oldBackupKey, newBackupKey)`
   → `fetchChain` → append the new link → `appendChainLink` (PUT).
4. **rotating**:
   - Build request body without `continuity_signature`.
   - `signContinuity(oldAuth.privateKey, body)` → signature bytes.
   - `rotateKeys(session.token, {...body, continuity_signature})`.
   - On `409 key_version_stale`: another device rotated first →
     wipe local state, go to login. (Reuse the wipe helper from
     task 5; for this task, just call `clearSession` and
     `navigate('/login')`.)
   - On success: response carries `{token, key_version}`. Build the
     new `Session`, `saveSession`, call `onSuccess(newSession)`.
5. **done**: brief confirmation, then return to settings.

If any step throws, surface a single `error` string and reset
`step` to `enter`. The orphaned chain entry (if step 4 failed after
step 3) is harmless per the spec.

### 2. New component: `ChangePasswordPanel`

[web/src/components/ChangePasswordPanel.tsx](../web/src/components/ChangePasswordPanel.tsx):

```tsx
interface Props {
    step: RotateStep;
    currentPassword: string;
    newPassword: string;
    confirmPassword: string;
    error: string | null;
    onCurrentChange: (v: string) => void;
    onNewChange: (v: string) => void;
    onConfirmChange: (v: string) => void;
    onSubmit: () => void;
}
```

Layout:

- "Current password" field.
- "New password" field with strength meter (from task 1's
  `PasswordStrengthMeter`).
- "Confirm new password" field.
- Acknowledgement checkbox: "I understand that if I forget this
  password, my account and history are unrecoverable."
- Submit button: disabled unless current is non-empty, new + confirm
  match, checkbox is checked, and step is `enter`.
- During `deriving-*`, `writing-chain`, `rotating` steps: replace
  the form with a labelled spinner / minimal animation. Reuse
  [AuroraBackground](../web/src/components/AuroraBackground.tsx)
  or a smaller variant per task 1's pattern.
- During `done`: a one-line "Password changed" confirmation; after
  ~1.5 s the panel re-renders in `enter` state with empty fields.

Stays presentational. No `useEffect`/etc.

### 3. Wire into settings route

[settings.tsx](../web/src/routes/settings.tsx):

```tsx
const rotate = useRotateKeys(session, profileFromSession(session), onSessionChange);

return (
    <ProfileSettings handle={session.handle} token={session.token}>
        <ChangePasswordPanel
            step={rotate.step}
            currentPassword={rotate.currentPassword}
            // ...
            onSubmit={rotate.submit}
        />
        <DeviceSettings {/* existing */} />
    </ProfileSettings>
);
```

`onSessionChange` is the existing session-replacement callback used
elsewhere (extend if needed; the App component already manages
session in state and re-renders on change).

### 4. Session shape gains `keyVersion`

If task 1 didn't already do this: [auth.ts](../web/src/lib/auth.ts)
`Session` gains `keyVersion: number`, persisted in `localStorage`.
`loadSession` reads it; on legacy sessions without the field, default
to `1`. `useRotateKeys` reads it from the session, not from a fresh
`resolve` call.

### 5. v2 auth-proof generation: confirm it's already wired

`signAuthProofV2` and the `useLogin` dispatch on
`resolve.key_version > 1` are both delivered by
[task 1](credential-registration.md). This task does *not* need to
add them — but it's the first task where they actually fire in
production:

- Rotation flips an account from `key_version: 1` to
  `key_version: 2`.
- Any subsequent add-device call (a fresh device logging in with
  the new password) hits the v2 branch in `useLogin` and emits a
  v2 auth proof.

Sanity-check during this task's implementation: run the e2e flow
*ending in a fresh-context login on the rotated account* (verify
section step 9 below) and confirm the network-tab payload of the
`POST /v1/devices` call carries a v2-shaped payload
(`{user_id, device_id, timestamp, key_version: 2}`). If task 1
shipped without the dispatch, this is the symptom you'd see, and
this task should treat it as a blocker — fix in task 1's hook
rather than working around it here.

### 6. Settings route props update

Make sure the `App` component passes a session-mutator callback into
`SettingsRoute`. Today the session is reloaded by other paths;
rotation needs to swap it in place with the new token.

## Out of scope

- Detecting that *another* device rotated and forcing this device
  through re-login. That's task 5.
- Re-encrypting in-flight messages or media. Not affected by
  rotation.
- "Rotate without changing the credential" — i.e. periodic re-key
  with the same password. Not a v0.1 feature; the rotation endpoint
  supports it mechanically but no UI is added.

## Verify

`make fmt lint test` clean.

**Vitest:**

- `useRotateKeys.test.ts`:
  - Happy path: mock `argonStretch`, `deriveKeys`, `appendChainLink`,
    `rotateKeys` → assert final session has new token + new key
    material; assert call order (chain write *before* rotate).
  - Wrong current password: derivation succeeds but `auth.publicKeyBytes`
    doesn't match `profile.auth_public_key` → error surfaced, step
    reverts to `enter`, no API calls made.
  - `409 key_version_stale` from `rotateKeys`: hook calls
    `clearSession` and navigates to `/login`.
  - `403 bad_continuity`: hook surfaces "rotation failed" error
    without wiping local state (the user's existing session is
    still valid).
  - Chain-write failure: error surfaced, `rotateKeys` not called.

**Storybook:**

- `ChangePasswordPanel`: each step variant (`enter`, `deriving-old`,
  `deriving-new`, `writing-chain`, `rotating`, `done`, error state
  in `enter`).

**Playwright e2e (`web/e2e/credential-rotate-ui.spec.ts`):**

1. Alice registers in context A with password `original-passphrase-strong-1`.
2. Sends a saved-messages message ("note 1") so there's history.
3. Navigates to `/settings`, opens Change Password panel.
4. Enters wrong current password → sees inline error, no rotation.
5. Enters correct current + new password
   `rotated-passphrase-strong-2`, checks acknowledgement, submits.
6. Waits for `done` state (allow ~10 s for the two Argon2id passes
   on slow CI machines).
7. Sends "note 2" — confirms the session is still working with the
   new keys.
8. Signs out (still context A), signs back in with
   `rotated-passphrase-strong-2`, confirms `note 1` (via chain) and
   `note 2` (via current key) both decrypt.
9. **Fresh-device join after rotation**: open a *second* browser
   context B with a clean profile (no IDB, no localStorage), call
   `loginUser(B, handle, 'rotated-passphrase-strong-2')`, assert:
   - The login completes (proves the v2 auth-proof emission from
     task 1 actually fires for `key_version: 2`).
   - `note 1` is visible (proves `key_chain.json` was fetched,
     walked, and the v1 backup key recovered on a device that
     never held it before).
   - `note 2` is visible (proves the current backup key is in
     play).
   - Open DevTools (`context.tracing` or a captured request log)
     and assert the `POST /v1/devices` payload carries
     `key_version: 2`. This is the canary for the cross-task
     v2-auth-proof wiring.

**Manual:**

- On a real phone (or throttled Chrome DevTools), confirm both
  Argon2id passes fit inside the animation cover and don't trigger
  jank. Total time budget: under ~12 s including network.
- After rotation, log in with the *old* password on a second
  device. Confirm it fails (proves `profile.auth_public_key` was
  actually swapped).
