# Remove legacy BIP39 mnemonic credential support

The credential-overhaul series ([tasks 1–5](README.md#credential-overhaul-highest-priority))
shipped the Argon2id password (v2) flow and kept the mnemonic (v1)
paths in as a deliberate migration-mechanism rehearsal — see the
[legacy-as-migration-test](/Users/atmin/.claude/projects/-Users-atmin-dev-atmin-net/memory/legacy_as_migration_test.md)
memo. This task retires those v1 paths once the migration is
validated in staging + production, leaving a single-path codebase.

## Motivation

Two costs of keeping v1 around indefinitely:

- **Branch surface in security-critical code.** Token parsing, auth
  proof verification, registration, and key/contact-backup envelope
  parsing all have a v1 branch. Each branch is a place where a
  refactor can mistakenly weaken v2 (e.g. accept a v1 auth proof
  shape when the caller meant to require v2). The v1 branches were
  worth the cost while we needed migration rehearsal; once that's
  done they're pure carry-cost.
- **Onboarding noise.** The login form still advertises "Password or
  recovery phrase," which leaks legacy detail to every new user.
  Removing it simplifies the UX and shrinks the surface area users
  have to reason about.

The cleanup is **gated on a hard prerequisite** (see *Prerequisites*
below): no remaining production account may be at v1 (`KeyVersion == 0`
or missing `salt`/`kdf` on `profile.json`), and no remaining backup
or contacts blob may lack the envelope `v` field. Both invariants
hold automatically after every account has rotated at least once via
the v2 rotate-keys path.

## Prerequisites

**Before this task starts:**

1. Staging validation: confirm via the staging Cockpit/Grafana board
   ([ops.md § log query recipes](../docs/ops.md)) that all
   pre-cutoff staging accounts have rotated successfully, and that
   `GET /v1/store/list?prefix=keys/{uid}/live/` blobs are all v2-shaped
   (have a `v` field).
2. Production validation: same audit on production. If any account
   still has `KeyVersion == 0` after the validation window, force
   migration via an in-app banner ("legacy account; please change
   your password to continue"). Cleanup does not land until that
   banner is gone for ≥ 7 days with zero v1 accounts remaining.
3. The audit query is a single `ListObjects` per user against
   `users/{uid}/profile.json` followed by a check for `salt == ""` or
   `key_version == 0`. Scriptable; runs in seconds for v0.1 scale.

These prerequisites are not work items inside this task — they are
the gate that decides *when* this task starts. The user owns the
verification.

## Current state

**Server (Go).** The v1 branches are localised to four files:

- [auth.go:48–60](../server/auth.go) — `parseToken()` accepts a
  3-segment token with implicit `kv=1`.
- [auth.go:160–172](../server/auth.go) — `verifyAuthProof()`
  accepts a v1 payload (no `key_version` field, plain `json.Marshal`
  signed instead of JCS).
- [handlers.go:57–68](../server/handlers.go) — `handleRegister`
  accepts a request with both `salt` and `kdf` absent (v1 creates a
  profile with `omitempty` salt/kdf/key_version).
- [handlers.go:220–243](../server/handlers.go) — `fetchAndVerifyAuthProof`
  has a "v1 proof ⇒ implicit kv=1" branch.

`profile.go` carries `omitempty` on `Salt`, `KDF`, `KeyVersion`
specifically to support the v1 shape.

**Client (TypeScript).**

- [lib/credential.ts:22–28](../web/src/lib/credential.ts) —
  `isLegacyMnemonic()` (BIP39 checksum + length probe).
- [lib/credential.ts:43–54](../web/src/lib/credential.ts) —
  `deriveSecretFromCredential()` autodetect (mnemonic → direct HKDF;
  password → Argon2id → HKDF).
- [lib/key-backup-envelope.ts:62–82](../web/src/lib/key-backup-envelope.ts)
  — accepts an envelope with no `v` field as implicit `v: 1`.
- [components/LoginForm.tsx:110–124](../web/src/components/LoginForm.tsx)
  — "Password or recovery phrase" placeholder + "legacy 12-word
  phrase" hint.
- [hooks/useLogin.ts:16](../web/src/hooks/useLogin.ts) — re-exports
  `isLegacyMnemonic` for tests.

**Tests.** Three pure-legacy tests and one dual-use:

- [server/credential_test.go](../server/credential_test.go) —
  `TestRegisterV1OmitsCredentialParams` (pure legacy).
- [server/rotate_test.go](../server/rotate_test.go) —
  `TestRotateKeys_V1ToV2Migration` (depends on the v1 register path
  being reachable; delete with this task).
- [server/handlers_test.go](../server/handlers_test.go) — the test
  fixture `registerTestUser` doesn't go via the v1 path, so no
  changes needed there.
- [web/src/hooks/useLogin.test.ts](../web/src/hooks/useLogin.test.ts)
  — the `isLegacyMnemonic` test block + the mnemonic autodetect
  branches of the `useLogin` block (lines 51–80 + the mnemonic
  cases in the login matrix).

**Docs.**

- [docs/specs/mvp-v0.1.md](../docs/specs/mvp-v0.1.md) — the
  "legacy mnemonic" paragraphs in *Credentials*, *Auth proof*,
  *Register*, and *Login* sections.
- [docs/scenarios/credential-registration.md](../docs/scenarios/credential-registration.md)
  — the "v1 (legacy mnemonic) registration omits salt/kdf" callout.
- ADRs 0011, 0012, 0013 — all currently **Draft** (verified). Per
  the project's ADR rules, draft ADRs are edited directly; accepted
  ADRs require a follow-up. No follow-up ADR is needed here, but
  the cleanup commit must amend the relevant draft sections in
  place.

## Architecture constraints

- The HKDF info strings `"auth-v1"`, `"sharing-v1"`, `"backup-v1"`
  in [crypto.ts](../web/src/lib/crypto.ts) are **cryptographic
  commitments** rooted in every account's 16-byte secret. Their
  `v1` is unrelated to the credential v1/v2 split. **Do not rename
  them** — every existing account would lose access. Leave them
  alone, possibly with a comment clarifying the naming.
- `@scure/bip39` stays a dependency. After this cleanup,
  [handle-suggest.ts](../web/src/lib/handle-suggest.ts) is the
  only consumer (Surprise me button), but it is a real consumer.
- Envelope versioning (`v` field) stays; we're only removing the
  *fallback path that treats a missing `v` as 1*. New envelopes
  always carry `v`, so this only affects pre-cutoff blobs — which
  the prerequisite guarantees don't exist.
- The "v1 auth-proof shape" (no `key_version`, non-JCS) is being
  removed. After this cleanup, every auth proof is JCS-canonicalised
  with `key_version`. Single shape.

## Change

### 1. Server: drop v1 token / auth-proof / register branches

- [auth.go](../server/auth.go): delete the 3-segment branch in
  `parseToken()`; an undecodable token now uniformly returns
  `errUnauthorized`. Delete the v1 path in `verifyAuthProof()` and
  the comment that documents it.
- [handlers.go](../server/handlers.go): in `handleRegister`, drop
  the "both `salt` and `kdf` absent ⇒ v1 account" branch — both
  fields are now mandatory; an absent pair is `400 bad_request`.
  In `fetchAndVerifyAuthProof`, drop the "v1 proof ⇒ implicit kv=1"
  branch.
- [profile.go](../server/profile.go): remove `omitempty` from
  `Profile.Salt`, `Profile.KDF`, `Profile.KeyVersion`, and the same
  three fields on `publicHandleData`. Every projection now carries
  the full v2 shape.

### 2. Server tests: prune

- Delete `TestRegisterV1OmitsCredentialParams` and
  `TestRegisterPartialCredentialParams` ("salt without kdf",
  "kdf without salt") in [credential_test.go](../server/credential_test.go).
  The remaining `TestRegisterV2StoresCredentialParams` and the
  `TestRegisterMalformedKDF` golden-path coverage stay.
- Delete `TestRotateKeys_V1ToV2Migration` in
  [rotate_test.go](../server/rotate_test.go). Migration is no longer
  a supported flow; testing it would freeze a code path we just
  removed.
- Grep `registerTestUser` and `registerTestUserV2` call sites: any
  test that relied on the "auto-handle" / "no-salt-kdf" semantics
  should be updated to the v2 shape. Spot-check, don't rewrite
  blindly.

### 3. Client: drop the autodetect helper

- [lib/credential.ts](../web/src/lib/credential.ts): delete
  `isLegacyMnemonic`, delete the mnemonic branch in
  `deriveSecretFromCredential`, and rename what remains to just
  `deriveSecretFromPassword` (so the call sites in
  [useLogin.ts](../web/src/hooks/useLogin.ts) and
  [useRotateKeys.ts](../web/src/hooks/useRotateKeys.ts) read
  precisely). Or inline it into both call sites and delete the
  helper entirely if there's nothing left of substance — judgment
  call once the v1 branch is gone.
- [useLogin.ts](../web/src/hooks/useLogin.ts): drop the
  `isLegacyMnemonic` re-export. Remove the "Recovery phrase required
  for legacy account" error string (the v1→v2 fallback no longer
  applies).
- [key-backup-envelope.ts](../web/src/lib/key-backup-envelope.ts):
  remove the "missing `v` field ⇒ `v: 1`" fallback. Envelopes
  without `v` now fail to parse. (Pre-cutoff blobs are already
  gone, per prerequisite.)
- [contact-backup.ts](../web/src/lib/contact-backup.ts) — same
  cleanup if it has a parallel v1 fallback; check.

### 4. Client UI: simplify the login form

- [LoginForm.tsx](../web/src/components/LoginForm.tsx): change the
  field label/placeholder/hint to plain "Password," matching the
  registration screen's framing. Drop the "legacy 12-word phrase"
  paragraph. Remove the `autoComplete="current-password"` no
  longer needs the dual-purpose explanatory text.
- [LoginForm.stories.tsx](../web/src/components/LoginForm.stories.tsx)
  — if any story explicitly demonstrated the legacy phrase, remove
  it.

### 5. Client tests: prune the mnemonic matrix

- [useLogin.test.ts](../web/src/hooks/useLogin.test.ts):
  - Delete the entire `describe('isLegacyMnemonic', ...)` block.
  - Delete the "legacy mnemonic login decodes directly and emits a
    v1 auth proof" case in the `describe('useLogin', ...)` block.
  - Delete the "password login against a legacy (v1) account asks
    for the recovery phrase" case.
  - The remaining v2 cases (`v2 password login at key_version 1`,
    `at key_version > 1`, `not_found`, `released`, normalization)
    stay.
  - Drop the `entropyToMnemonic` + `wordlist` imports and the
    `VALID_MNEMONIC` constant.
- Other client tests that mock `deriveSecretFromCredential` should
  be updated to use the new name (or inlined replacement).

### 6. Spec + ADR updates (direct edits — all relevant ADRs are Draft)

- [mvp-v0.1.md](../docs/specs/mvp-v0.1.md):
  - In *Credentials*, drop the "v1 (legacy mnemonic)" paragraph.
    Keep the historical note that the field used to be a 12-word
    phrase — one sentence is enough.
  - In *Register*, drop the "v1 registration paths (no salt/kdf in
    the request) are retained" paragraph.
  - In *Auth proof*, drop the **v1 payload** code block + the
    paragraph that introduces it. Only the v2 (JCS, with
    `key_version`) shape remains.
  - In *Login*, drop the "autodetect" callout. The form takes a
    password; there is no fork.
- [adr-0011-credential-derivation.md](../docs/decisions/adr-0011-credential-derivation.md)
  (Draft):
  - In *Legacy login UX*: replace the autodetect-flow paragraph
    with a one-paragraph historical note ("v1 BIP39 mnemonic was
    supported for migration rehearsal; removed in commit `<hash>`").
  - In *Two derivation paths in the codebase until legacy sunset*:
    delete the section, or rewrite as "Single derivation path;
    legacy paths removed."
  - In *Migration*: delete or condense.
- [adr-0012-backup-secret-rotation.md](../docs/decisions/adr-0012-backup-secret-rotation.md)
  (Draft):
  - Remove references to "v1→v2 migration during rotation" — the
    rotate flow now only handles v2→v2.
  - The "Contact sharing-key refresh" section ADR-0012 amendment
    is unaffected; leave it intact.
- [adr-0013-user-chosen-handles.md](../docs/decisions/adr-0013-user-chosen-handles.md)
  (Draft): only touched if it references mnemonic. Spot-check; if
  no references, no change.
- [docs/scenarios/credential-registration.md](../docs/scenarios/credential-registration.md):
  drop the "v1 (legacy mnemonic) registration omits salt/kdf"
  callout in the *Register* section.
- [docs/scenarios/credential-rotation.md](../docs/scenarios/credential-rotation.md)
  and [credential-multi-device-cutoff.md](../docs/scenarios/credential-multi-device-cutoff.md):
  spot-check for mnemonic mentions; none expected after the
  earlier amendments but worth a final grep.

### 7. Cross-references

- [tasks/README.md](README.md): delete this entry once the task
  lands. Add a one-line summary to the credential-overhaul intro
  paragraph noting "legacy mnemonic support was removed in `<commit>`."
- Memory: the
  [planned-legacy-cleanup-task](/Users/atmin/.claude/projects/-Users-atmin-dev-atmin-net/memory/planned_legacy_cleanup_task.md)
  memo can be deleted by the next conversation that needs to update
  memory — it'll be stale once this lands.

## Out of scope

- **HKDF info-string rename**. The `"auth-v1"` etc. info strings
  are cryptographic commitments. Renaming them would break every
  account. They are not in scope here and never will be unless a
  full crypto migration is undertaken with its own ADR.
- **Server-side BIP39 wordlist removal**. The wordlist embed was
  already deleted as part of [custom-handles](custom-handles.md)
  — confirm it's gone (`server/bip39_english.txt` should not exist).
- **Removing `@scure/bip39` from the client**. Still used by
  [handle-suggest.ts](../web/src/lib/handle-suggest.ts). Dependency
  stays.
- **Per-account audit script**. Listed under *Prerequisites*; the
  cleanup task assumes it's already been done. If a generic audit
  tool grows out of this, that's its own task.

## Verify

`make fmt lint test` clean. `pnpm tsc` + `pnpm build` clean. Full
e2e suite green (including the existing credential-* and
custom-handles specs — none should require updates since they all
use v2 already).

**Server tests (after pruning):**

- The full table of `TestRegisterMissingFields` cases still passes
  (now including a "missing salt" and "missing kdf" case where
  before those were valid v1 inputs).
- A new table-driven case in `TestRegister...` for "registration
  with `salt` absent but `kdf` present (and vice versa)" returns
  `400 bad_request`. Today these return 400 too, but for the
  "partial set" reason; after cleanup they're 400 because both
  fields are unconditionally required. Same outcome, slightly
  different code path.
- A regression case in `auth_test.go`: a synthetic 3-segment token
  (the old v1 shape) now returns 401 instead of being parsed.
  Pins the removal so a future refactor doesn't accidentally
  reintroduce the v1 parse path.
- Existing tests that previously exercised v1 paths (deleted in
  step 2) should be reflected as net-removed lines in the diff,
  not refactored-around.

**Client tests:**

- `pnpm vitest run` passes with the v1-related tests removed.
- The remaining `useLogin` tests cover the v2 password matrix at
  `kv=1` and `kv>1`, plus the `not_found` / `released` /
  normalization branches.
- `useRotateKeys` no longer tests the v1→v2 migration case;
  remaining cases (happy path, wrong-password, 409/403, chain-fail)
  unchanged.

**E2E:**

- The existing credential-registration, credential-rotate-ui,
  credential-multi-device-cutoff, custom-handles, and
  invariants/credential-rotation-continuity specs all pass without
  modification.
- Manual: the login form on a fresh build no longer mentions
  "recovery phrase" anywhere. The placeholder is "Password." The
  hint paragraph is either gone or reduced to a single benign line.

**Manual on staging (the prerequisite, restated):**

- After the cleanup lands, `GET /v1/resolve/{handle}` for every
  previously-existing staging account returns a 200 with non-empty
  `salt`, `kdf`, and `key_version >= 1`. No 500s, no decode failures.

## Risk if the prerequisite isn't met

If any v1 account still exists in production when the cleanup
lands, that account's next API request returns 401 (its v1 token no
longer parses) and the user is locked out with no in-app recovery
path. The bias is therefore toward a conservative gate: zero v1
accounts for ≥ 7 days before merging. The validation work itself is
the user's call; this task assumes it's done.
