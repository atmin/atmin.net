# Settings → "Delete account"

The server endpoint exists and is tested
([`DELETE /v1/profile` in handlers.go:489](../server/handlers.go);
writes a 30-day handle tombstone via the custom-handles work). What's
missing is the **user-facing path to invoke it** — there is no button,
no panel, no API wrapper. A user who wants to leave today cannot.

This task adds the Settings panel and wires it end-to-end.

## Motivation

GDPR-adjacent baseline: a user must be able to delete their account
without contacting the operator. Beyond compliance, "I can leave at
any time" is a privacy-product table-stake — its absence raises
exactly the kind of question we want users *not* asking
("is my data hostage?").

Specs:
[`docs/scenarios/account-deletion.md`](../docs/scenarios/account-deletion.md)
(server-side flow — see *Out of scope* for the doc refresh that
folds in custom-handles' tombstone behaviour),
[ADR-0013 § Deleted-handle cooldown](../docs/decisions/adr-0013-user-chosen-handles.md)
(why the handle survives 30 days even after the account is gone).

## Current state

- [`server/handlers.go:489–569`](../server/handlers.go) — `handleDeleteProfile`
  deletes all per-user data and writes the handle tombstone under
  the per-handle mutex. Tested in
  [`server/handlers_test.go:296`](../server/handlers_test.go).
- [`web/src/lib/api.ts:244`](../web/src/lib/api.ts) — `deleteDevice`
  exists; **no `deleteProfile` wrapper**.
- [`web/src/routes/settings.tsx`](../web/src/routes/settings.tsx) —
  renders ProfileSettings, ChangePasswordPanel, DeviceSettings. No
  delete-account section.
- [`docs/scenarios/account-deletion.md`](../docs/scenarios/account-deletion.md)
  — predates custom-handles; describes the handle as being deleted
  outright rather than tombstoned. Needs a refresh as part of this
  task.

## Architecture constraints

- **Password verification is cryptographic, not just a UI gate.** The
  delete flow re-derives the Argon2id secret client-side, derives the
  auth public key, and compares against `profile.auth_public_key`
  (the same pattern as [`useRotateKeys.ts:107–114`](../web/src/hooks/useRotateKeys.ts)).
  This means a stolen unlocked device can't delete the account
  without the password — and the password is never sent to the
  server.
- **Token stays valid through the call.** The middleware's
  `requireAuth` runs first; the handler deletes the device file
  inside the `users/{uid}/` sweep, after which any *subsequent*
  request 401s. The in-flight delete request itself still
  authenticates because the device-cache check has already passed
  by then. This is the same idempotency property the existing
  `TestDeleteProfile` / `TestDeleteProfileAlreadyDeleted` server
  tests rely on.
- **Saved Messages handle (`/saved`) is not a real handle.** No
  special-casing needed in this flow.
- **Multi-device implication.** A successful delete invalidates
  every other device's token on its next request (device file is
  gone → 401 → existing `device_revoked`/`unauthorized` auth-event
  handlers wipe local state and route to /login, where the user
  sees "no account with that handle"). The UI copy must say this
  plainly.

## Change

### 1. API wrapper

[`web/src/lib/api.ts`](../web/src/lib/api.ts):

```ts
export function deleteProfile(token: string): Promise<void> {
    return request('DELETE', '/v1/profile', { token });
}
```

That's the whole wrapper — no body, just the bearer token. The
server's 200/404/401 surface flows through the existing `request`
helper.

### 2. Hook: `useDeleteAccount`

[`web/src/hooks/useDeleteAccount.ts`](../web/src/hooks/useDeleteAccount.ts)
(new). Modeled on `useRotateKeys`. State machine:

```
'enter' → 'verifying' → 'deleting' → 'done'
            ↓ wrong password
          'enter'
```

Surface:

```ts
export type DeleteStep = 'enter' | 'verifying' | 'deleting' | 'done';

export interface DeleteState {
    step: DeleteStep;
    password: string;
    handleConfirm: string;       // typed-handle confirmation
    acknowledged: boolean;       // checkbox: "I understand this cannot be undone"
    error: string | null;
    setPassword: (v: string) => void;
    setHandleConfirm: (v: string) => void;
    setAcknowledged: (v: boolean) => void;
    submit: () => Promise<void>;
}

export function useDeleteAccount(
    session: Session,
    onDeleted: () => void,
): DeleteState;
```

Submit flow:

1. **Verify password locally** (`step: 'verifying'`). Read
   `users/{uid}/profile.json` via `storeGet` to get salt + kdf, run
   the standard Argon2id → HKDF chain, derive the auth public key,
   compare against `profile.auth_public_key`. Mismatch → set error
   "Password is incorrect.", return to `'enter'`. **No server
   round-trip on a bad password** (same property as `useRotateKeys`).
2. **Server-side delete** (`step: 'deleting'`). `await deleteProfile(session.token)`.
3. **Wipe + sign out** (`step: 'done'`). `await clearSession()` (full
   IDB wipe — local data is now ciphertext with no remaining
   counterpart on the server). Call `onDeleted()`; route to `/`
   (Landing, since session is gone) carrying a transient
   confirmation (see *Post-deletion confirmation* below).

Error mapping: a 401 partway through (race with another device's
delete) means we lost the race but the account is gone anyway —
proceed as if successful (clear session, navigate, show the
confirmation). A 5xx surfaces as `"Could not delete account. Please
try again."`

### 2a. Post-deletion confirmation

A silent drop onto the Landing page reads as "did that work?" — the
destructive action deserves an explicit acknowledgement. Surface a
**transient** confirmation on Landing after a successful delete:

> ✓ Your account has been deleted.

Reuse the existing notice channel rather than inventing a parallel
one. `useSession` already carries a `notice` for the
`rotated_elsewhere` cutoff case ([useSession.ts](../web/src/hooks/useSession.ts),
added by credential-multi-device-cutoff); extend its `LoginNotice`
union with `'account_deleted'` and set it from the delete flow's
`onDeleted` callback, exactly as the cutoff path sets
`'rotated_elsewhere'`. The difference is the destination: deletion
has no account, so it renders on **Landing** (`/`), not the login
form.

- [Landing](../web/src/routes/landing.tsx) reads the notice and
  renders a calm, dismissible line (same muted-confirmation
  styling as the login notice — green check, `text-muted-foreground`
  body). Auto-dismiss after ~5 s, and clear on any navigation or
  interaction so it never lingers into a later visit.
- `clearNotice` (already exposed by `useSession`) clears it; the
  Landing component calls it on unmount / on its CTA clicks.
- Because the notice lives in `useSession` state (not routing
  `location.state`), it survives the `clearSession()` + re-render
  without a query param, and a manual refresh of `/` afterwards
  shows nothing — which is correct (the confirmation is a one-shot,
  not a persistent banner).

### 3. UI panel

[`web/src/components/DeleteAccountPanel.tsx`](../web/src/components/DeleteAccountPanel.tsx)
(new). Visually subordinate (small destructive footer in Settings,
not a hero card) so it doesn't compete with the everyday actions
above it.

Layout:

```
─── Danger zone ──────────────────────────────
| Delete account                              |
| Permanently delete @{handle} and all your   |
| data. This cannot be undone.                |
|                                             |
| [ Delete account ]  ← outlined destructive   |
─────────────────────────────────────────────
```

Click → expands inline (or opens a Dialog — pick whichever is
already the project pattern for destructive confirmations; the
existing device-revoke flow uses an inline reveal, so match that)
into the confirmation form:

```
What will be deleted
- Your profile, contacts, conversation history, key backups, and
  uploaded media.
- All your sessions on every device.
- Your handle @{handle} will be reserved for 30 days, then becomes
  available to anyone. This is symmetric: nobody — including you —
  can claim it during that window.

What will not be deleted
- Messages you've sent to others (their copies remain on their
  devices and in their inboxes).

[ Password ]                            ← masked input
[ Type your handle to confirm ]         ← must equal session.handle
[x] I understand this cannot be undone.

[ Delete account ]                      ← destructive, gated
[ Cancel ]
```

Gating: button enabled only when password is non-empty AND
`handleConfirm === session.handle` AND acknowledged. The
double-confirmation (password + typed handle) is the same pattern
GitHub uses for repo deletion; the typed handle defeats reflexive
muscle-memory clicks even when the user knows their password.

While deleting (`'verifying'` or `'deleting'`), show a small per-step
cover ("Verifying your password…" / "Deleting your account…") so the
user knows something is happening — Argon2id is several seconds on a
mid-tier device.

### 4. Wire into Settings

[`web/src/routes/settings.tsx`](../web/src/routes/settings.tsx):

- Pass `session` + `onLogout` (or a new `onDeleted` callback) down
  to the panel.
- On `onDeleted`, the route should clear in-app state and navigate;
  the simplest wire-up is to call the same `handleLogout` from
  `useSession` that the chats route already calls — clearSession +
  navigate to `/`. The route doesn't render the panel without a
  session, so this is symmetric to the existing logout path.
- Render the panel **last**, below DeviceSettings, with visual
  separation. The architecture rule (routes/ no className) means the
  separation is the panel's responsibility, not the route's.

### 5. Scenario doc refresh

[`docs/scenarios/account-deletion.md`](../docs/scenarios/account-deletion.md)
predates custom-handles and shows the handle being deleted outright.
Refresh:

- Step 2: server **writes a tombstone** at `handles/{handle}.json`
  rather than deleting; resolve returns 410 with `{released_at,
  available_at}` during the cooldown window. Cross-reference
  ADR-0013 § *Deleted-handle cooldown*.
- Step 4: Bob's resolve returns 410, not 404. His client renders
  "That account was deleted on YYYY-MM-DD" (the same UX
  useLogin already implements).
- Add a *Client-side flow* section describing the new UI:
  password re-derivation, typed-handle confirmation, multi-device
  sign-out propagation.
- Update the *What to test* checklist to match the new e2e (below).

### 6. Tests

**Vitest** ([`useDeleteAccount.test.ts`](../web/src/hooks/useDeleteAccount.test.ts)),
mirroring `useRotateKeys.test.ts`:

- Happy path: derives, verifies, calls `deleteProfile`, clears
  session, navigates, sets the `account_deleted` notice.
- Wrong password: derived pubkey ≠ `profile.auth_public_key` ⇒
  error surfaces, no `deleteProfile` call, no `clearSession` call,
  no notice set.
- 5xx during delete: error surfaces, session NOT cleared (the
  user might want to retry), no notice set.
- 401 during delete (lost the race): session cleared + navigated +
  notice set anyway.

Plus a `useSession` test: setting `account_deleted` exposes it on
`notice`, and `clearNotice` clears it (extends the existing
`rotated_elsewhere` notice tests).

**Storybook** ([`DeleteAccountPanel.stories.tsx`](../web/src/components/DeleteAccountPanel.stories.tsx)):
collapsed, expanded-blank, expanded-filled, verifying, deleting,
done, error.

**Playwright e2e**
([`web/e2e/account-deletion-ui.spec.ts`](../web/e2e/account-deletion-ui.spec.ts)):

1. Alice registers; opens Settings; expands the Danger zone.
2. Wrong password → "Password is incorrect." Form stays open; no
   network call to `/v1/profile`.
3. Typed handle doesn't match → submit button stays disabled.
4. Correct password + matching handle + acknowledgement → submit.
5. Wait for landing page. The transient "✓ Your account has been
   deleted." confirmation is visible. Local IDB is gone
   (`indexedDB.databases()` returns empty or no `atmin` DB).
   Reloading `/` afterwards shows no confirmation (one-shot).
6. From a *second* browser context already signed in as Alice
   (set up before the delete), navigate anywhere — auth event
   triggers session wipe + redirect to /login. This is the
   existing `device_revoked` / `unauthorized` flow; the test
   pins that account-deletion exercises it.
7. From a third context: `GET /v1/resolve/{aliceHandle}` returns
   410 with cooldown timestamps (proves the tombstone path).
8. From the same third context, registration with `aliceHandle`
   returns the form's "in cooldown until YYYY-MM-DD" indicator.

## Out of scope

- **Server-side changes.** None — `DELETE /v1/profile` is already
  the right shape.
- **Cancellable / undo deletion.** Would require server state for
  pending deletions; not for v0.1. The 30-day handle cooldown is
  the only "I changed my mind" affordance, and only for the handle,
  not the data.
- **Data export ("download my messages first").** Genuinely
  useful, but a separate feature with its own design surface (what
  format? media included? signed?). File a follow-up if there's
  demand.
- **Email/SMS reconfirmation.** No email/SMS in the system; not
  introducing them just for this.
- **Per-device "delete only this device".** Already exists as
  device revoke from the Devices panel. The Danger zone copy
  links to it: *"Want to leave on just this device? Sign out from
  Devices instead."*
- **Audit of orphaned dead-letter inbox blobs.** Senders can still
  POST to a deleted user's inbox (server-side issue, not addressed
  by the UI). The handle-tombstone resolve makes most senders stop
  trying, but the catch-all is the
  [server-cleanup-routine](server-cleanup-routine.md) task —
  cross-referenced, not duplicated here.

## Verify

`make fmt lint test` clean. `pnpm tsc` + `pnpm build` clean.

- All `useDeleteAccount.test.ts` cases pass.
- Storybook renders all panel states without console errors.
- The new e2e spec passes; existing e2es (especially
  credential-rotate-ui, credential-multi-device-cutoff,
  custom-handles, invariants/credential-rotation-continuity)
  stay green.
- Manual on staging: delete an account, confirm the handle is
  410-resolvable, confirm a second device gets kicked to /login,
  confirm the freed handle can be re-registered after 30 days
  (or after running the cleanup-routine sweep early on staging).

## UX rationale (the choices the panel makes, briefly)

- **Cryptographic password gate, not a server confirm.** Same
  pattern as change-password. A device that's unlocked but whose
  user doesn't remember their password is therefore safe from
  accidental + drive-by deletion. Costs the user a few seconds of
  Argon2id; bought as defence in depth.
- **Typed-handle confirmation.** GitHub-style; defeats reflexive
  "click through everything" deletion. Cheap; high signal.
- **No grace period / "undo within N days".** Adds server-side
  state for a corner case. Users who change their mind can stop
  the click before submit; once submitted, the local data is
  encrypted with keys no one has anymore.
- **Surface what survives.** Recipients' copies of sent messages
  are out of our control; saying so plainly is more honest than
  a generic "your data" claim.
- **Surface the cooldown specifically.** The 30-day handle
  reservation is a real consequence and the most common
  "wait, what?" moment from custom-handles' deletion path.
  Stating it up front is cheaper than answering it later.
- **Don't bury it; don't over-hero it.** The panel is in
  Settings (where users go when they intend to manage their
  account), styled as a quiet "Danger zone" footer (so it doesn't
  visually compete with the everyday actions).
- **Transient confirmation, not silence.** Landing on the welcome
  screen with no acknowledgement reads as "did that work?" — a
  one-shot "✓ Your account has been deleted." closes the loop, then
  gets out of the way (auto-dismiss, cleared on interaction). It
  rides the existing notice channel so it costs almost nothing.
