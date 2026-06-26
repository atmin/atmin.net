# "Remember me" + idle session expiry

> Split out of [clear-local-state-on-auth](clear-local-state-on-auth.md). A
> "Remember me" checkbox on login/register that picks the session's idle
> lifetime; an idle session past its window forces re-auth. **Needs an ADR.**

## The decisive constraint

The device bearer token has **no server-side expiry** — it's
`HMAC(uid.did.kv)`, no timestamp ([server/src/token.rs](../server/src/token.rs)).
A token is valid until the *device* is revoked (`deleteDevice`) or `key_version`
bumps. So **clearing the local token does not invalidate it**: client-side
expiry is a UX + local-data-exposure control, *not* a token-invalidation
boundary. The only true server-side revocation is `deleteDevice` (which explicit
logout already calls best-effort — [useSession.ts](../web/src/hooks/useSession.ts)).

This is the load-bearing *why* the ADR must record.

## Design (proposed)

Tie the posture to the checkbox rather than treating both paths the same:

| "Remember me" | Idle window | On expiry | Device server-side |
|---|---|---|---|
| **Checked** (personal device) — **default** | 30d sliding | clear token only, **keep cache** | keep (you'll be back) |
| **Unchecked** (shared/public) | 1h sliding | **full `clearSession()` wipe** + `deleteDevice` | **revoke** (true logout, no trace) |

- **Default checked** (long-lived). A 1h-idle default that wipes + forces
  password re-entry + full S3 re-sync is punishing for a personal-device PWA;
  *unchecking* is the deliberate "shared machine" act.
- The account-change wipe from I11 still guards account-switching in **both**
  rows — expiry is orthogonal to it.

## Current

- No client-side session TTL or activity tracking anywhere; sessions persist
  indefinitely in localStorage + IDB until logout.
- Server tracks `last_active` (profile, SSE-connect, 1h coalescing) for cleanup
  (ADR-0006) only — not exposed to the client for expiry.
- Login/register forms are Konsta; register already has an ack `Checkbox`
  (`register-ack`) to mirror for the "Remember me" box ([LoginForm.tsx](../web/src/components/LoginForm.tsx),
  [RegisterForm.tsx](../web/src/components/RegisterForm.tsx)).

## Change

1. **ADR** — session-lifetime model: why client expiry ≠ token invalidation, the
   wipe/revoke-by-checkbox split, default-checked. (Trust-boundary + session
   semantics → ADR-worthy.)
2. Store `atmin:lastActive` + `atmin:rememberMe` in localStorage. On app boot
   and on `visibilitychange`/focus, if `now − lastActive > window` → expire per
   the table. Bump `lastActive` on activity (API calls / SSE) — a tab in active
   use never expires (sliding window).
3. Add the Konsta "Remember me" checkbox to LoginForm + RegisterForm; thread the
   choice through `useLogin`/`useRegister` into the stored flag.
4. Wire the unchecked-path expiry to `clearSession()` + `deleteDevice` (true
   logout); checked-path to a token-only clear that keeps the cache.

## Verify

- Konsta checkbox e2e: tick via label, assert via hidden input ([konsta-checkbox-e2e-hang]).
- e2e: unchecked + idle past 1h (fake the clock / stale `lastActive`) → wiped,
  back at login, device revoked remotely; checked + same → token cleared, cache
  intact, fast same-account re-login.
- Active-use tab never expires; account-change wipe (I11) still holds.
