# Registration proof-of-work

Implements [ADR-0020](../docs/decisions/adr-0020-registration-proof-of-work.md)
(supersedes [ADR-0007](../docs/decisions/adr-0007-registration-abuse-prevention.md)).
Add a memory-hard Argon2id proof-of-work to `POST /v1/register` so bulk account
creation pays a per-account RAM cost. No CAPTCHA, no third party, no PII, no
egress — fully in-process and EU-resident.

## Spec (what ADR-0020 mandates)

- **Server-issued challenge.** A new public `GET /v1/register/challenge` returns
  a single-use `nonce` and the difficulty (Argon2 params + a target). The client
  computes a proof; `register` submits it; the server verifies the proof meets
  **the difficulty it issued** — the client cannot lower it.
- **Memory-hard.** Argon2id, so GPUs/ASICs gain little — a botnet pays scarce
  memory per account.
- **Distinct from the credential KDF.** This PoW derives no key material and is
  discarded after verification. Weakening or disabling it lowers abuse resistance
  only, never confidentiality ([ADR-0016](../docs/decisions/adr-0016-server-enforced-kdf-floor.md)
  is the separate credential floor).
- **Tuning.** ~30s on a slow device, run in the background; a one-time tax, not a
  blocking step.
- **Fail-closed runtime switch.** `DANGEROUSLY_DISABLE_REGISTRATION_POW` matched
  against an exact magic value issues difficulty zero so both ends go cheap (e2e
  suite, local + CI prod-image). Any other value leaves the PoW on; a warning is
  logged at boot when off. This is the *opposite* mechanism to the KDF floor's
  compile-time bypass — matched to stakes×reach (low-stakes, must reach the CI
  prod-image run).

### Proof construction (the concrete scheme)

Canonical in [ADR-0020 § Proof construction](../docs/decisions/adr-0020-registration-proof-of-work.md#proof-construction)
— read it first; it is the durable record once this task is deleted. In short:
leading-zero-bits search with Argon2id as the hash (not fixed-work, which would
DoS the verifier), challenge `{ nonce, m, t, p, bits }`, proof `{ nonce, counter }`
bound to the nonce via the salt, nonce consumed before verify, proof verified only
after cheap input validation, one rejection code for all proof failures. Calibrate
`bits` against `m`/`t`/`p` so `2^bits × single-hash-time` ≈ 30s on a slow phone
(start near `m` ≈ 19 MiB, `outlen` 32, `counter` as LE u64 bytes); `bits = 0`
solves instantly.

## Current state

- **Register handler** [routes.rs:362](../server/src/routes.rs#L362) — manual
  JSON parse → handle charset/reserved checks → mandatory credential params
  (`valid_kdf_params`, the ADR-0016 floor) → per-handle claim lock → write
  projection/profile/device. No abuse control on the path.
- **Credential KDF** is the *only* Argon2 use today: WASM `derive_secret`
  ([web/crypto/src/argon2.rs](../web/crypto/src/argon2.rs)) run off-thread by
  [argon2-worker.ts](../web/src/lib/argon2-worker.ts) via `argonStretch`
  ([argon2-worker.client.ts](../web/src/lib/argon2-worker.client.ts)); params are
  `KdfParams {kind,m,t,p}` ([crypto.ts](../web/src/lib/crypto.ts)). The server
  floor lives in [profile.rs:18](../server/src/profile.rs#L18).
- **In-process ephemeral state** patterns to mirror for the nonce store:
  [cache.rs](../server/src/cache.rs) (`RwLock<HashMap<String, Instant>>` + TTL,
  `Instant`-based aging) and the per-handle [keyed_mutex.rs](../server/src/keyed_mutex.rs).
  Managed state is wired in `build()` at [routes.rs:77-84](../server/src/routes.rs#L77).
- **Client register flow** [useRegister.ts](../web/src/hooks/useRegister.ts) —
  steps `enter → deriving → registering → done`; calls `register()`
  ([api.ts:208](../web/src/lib/api.ts#L208)), DTO at [api.ts:94](../web/src/lib/api.ts#L94).
- **Config** [config.rs](../server/src/config.rs) — `env_opt` / `env_required`
  helpers; `ServerConfig` carries `server_secret`. New env vars go here **and**
  in [docs/ops.md](../docs/ops.md).
- **Errors** [error.rs](../server/src/error.rs) — `ApiError` enum → status + code
  + message, with a round-trip table to keep in sync.
- **Boot warning surface** [logging.rs](../server/src/logging.rs) — logfmt; emit
  the "PoW disabled" warning here / from `main`.

## Change

### Server

1. **`config.rs`** — add `registration_pow: PowConfig` to `ServerConfig`. Read
   `DANGEROUSLY_DISABLE_REGISTRATION_POW`; the PoW is **off** iff it equals the
   exact magic token (pick one, e.g. `"yes-i-am-the-e2e-suite"`), **on** for any
   other value or unset (fail-closed). `PowConfig` also holds the issued
   difficulty (`m`, `t`, `p`, `bits`) as constants with the active `bits` set to
   `0` when disabled. Document the env var here.

2. **`pow.rs`** (new module; declare in `lib.rs`, alphabetical) —
   - `PowChallenge { nonce, m, t, p, bits }` (Serialize) and `PowProof { nonce,
     counter }` (Deserialize).
   - `PowNonceStore` — `RwLock<HashMap<String, Instant>>` with a short TTL (e.g.
     5 min) mirroring `cache.rs`. `issue(nonce)` inserts; `consume(nonce) -> bool`
     removes and returns whether it was present-and-unexpired (single-use). Prune
     expired entries opportunistically on access (no background task).
   - `fn verify(proof, cfg) -> bool` — recompute `Argon2id(counter_le_bytes, salt
     = nonce_bytes, issued params, outlen 32)` and check `bits` leading zero bits.
     With `bits == 0` it accepts unconditionally (after nonce consume). Use the
     `argon2` crate already in the server dep tree? It is **not** a server dep
     today — add `argon2` to `server/Cargo.toml` (same crate the WASM side uses)
     for the single verify hash. Unit-test the leading-zero-bits check and the
     params round-trip.

3. **`routes.rs`** —
   - `GET /v1/register/challenge` handler (public, no guard): mint 16 random bytes
     → base64url `nonce`, `store.issue(nonce)`, return `Json<PowChallenge>` with
     the active difficulty. Register it in the `routes![]` list in `build()`.
   - `.manage(PowNonceStore::new())` in `build()`.
   - In `register`: add `pow: PowProof` to `RegisterRequest` (server model);
     **before** the handle-claim lock, `if !store.consume(&req.pow.nonce) ||
     !pow::verify(&req.pow, &config.registration_pow) { return Err(...) }`. Consume
     first so a failed proof still burns the nonce (no free retries on one
     challenge).
   - Order vs. existing checks: keep cheap rejects (malformed body, empty fields,
     handle charset/reserved, KDF floor) **before** the PoW verify so a bad
     request never costs an Argon2 hash; the PoW guards the expensive/abuse path,
     not input validation.

4. **`error.rs`** — add `PowInvalid` → `403 forbidden`-class with code
   `pow_invalid` (covers unknown/expired/reused nonce *and* a wrong proof — do not
   distinguish, to avoid an oracle). Add to the enum, the status match, the code
   match, the message match, and the round-trip table.

5. **`main.rs` / `logging.rs`** — at boot, if the PoW is disabled, emit a loud
   `log::warn!` line (logfmt) naming the switch. Production must never log this.

### Crypto (WASM)

6. **`web/crypto/src/argon2.rs`** — add
   `pub fn solve_pow(nonce: &[u8], m_kib: u32, t: u32, p: u32, bits: u32) -> u64`:
   loop `counter` from 0, hash `Argon2id(counter.to_le_bytes(), salt = nonce, …,
   outlen 32)`, return the first `counter` whose output has ≥ `bits` leading zero
   bits. `bits == 0` returns `0` immediately. Looping in Rust avoids a JS↔WASM
   crossing per attempt. Rebuild with `make web-wasm`.

### Web

7. **`api.ts`** — `PowChallenge` / `PowProof` types; `getRegisterChallenge():
   Promise<PowChallenge>` wrapper for `GET /v1/register/challenge`; add `pow:
   PowProof` to `RegisterRequest`. Unit-test the wrapper.

8. **`argon2-worker.ts`** — add a `solve_pow` message variant (alongside the
   existing derive) so the grind runs off the main thread; expose a
   `solvePow(challenge): Promise<PowProof>` in `argon2-worker.client.ts`.

9. **`useRegister.ts`** — add a `proving` step. Flow becomes
   `enter → deriving → proving → registering → done`: derive the credential secret
   (existing), fetch the challenge, `solvePow`, then `register({ …, pow })`. Map
   `pow_invalid` to a retryable "Registration check failed — please try again"
   message (re-fetching a fresh challenge on retry). Surface the `proving` step in
   the register UI route (a "Verifying…" line; the existing `deriving` spinner is
   the pattern).

### Tests

10. **Server** ([routes.rs](../server/src/routes.rs) `#[cfg(test)]`): challenge
    issues a nonce; `register` with a **valid** proof (compute it in-test with the
    `argon2` crate, or run with `bits = 0` via the disable switch for the golden
    path) succeeds; missing `pow` → `pow_invalid`; reused nonce → `pow_invalid`;
    unknown nonce → `pow_invalid`; expired nonce → `pow_invalid`. Existing
    register tests must set the disable switch (or pass a `bits=0` proof) so they
    keep passing — update the `register_body` test helper to include a trivial
    `pow`.
11. **Crypto/web**: `solve_pow` finds a counter whose hash meets a small `bits`
    target (unit test in the crypto crate); the verify side accepts it. `api.ts`
    wrapper test for the challenge endpoint.

### E2E enablement

12. The Playwright harness (local + the CI prod-image run) must set
    `DANGEROUSLY_DISABLE_REGISTRATION_POW=<magic>` so 100+ registrations/run stay
    fast. Wire it into the e2e env (`make e2e-local` / `make e2e` server launch)
    and document that the prod image honours it. **Do not** run a competing
    `:8080` server — reuse the existing harness wiring.

### Docs

13. **`docs/specs/mvp-v0.1.md`** — document the new `GET /v1/register/challenge`
    endpoint and the `pow` field on `POST /v1/register` in the Storage/registration
    section (elaboration of the live surface, not history rewriting — consistent
    with the earlier web-push edit). Reference ADR-0020.
14. **`docs/ops.md`** — add the `DANGEROUSLY_DISABLE_REGISTRATION_POW` env row
    (value semantics, fail-closed note, "set in e2e/test only — never production")
    and a one-line PoW note.
15. **`tasks/README.md`** — delete this task's entry once landed.
16. Consider a scenario/invariant: an invariant "registration requires a valid,
    single-use proof" (replay a consumed nonce → rejected) fits
    `docs/scenarios/invariants/`. Optional for the first cut; note it if deferred.

## Verify

- `make fmt lint test` green (Rust + Vitest); plus `pnpm tsc` + `pnpm build`
  (the gate skips these) and `make web-wasm` rebuilt the crate.
- New server unit tests (pow module, leading-zero-bits, nonce single-use) and
  handler tests (golden + the four `pow_invalid` rejections) pass.
- `make e2e-local` passes with the disable switch set — registration is instant.
- **Manual, prod-shaped (switch OFF):** boot the server without the env var →
  no disable warning logged; `GET /v1/register/challenge` returns a nonce +
  `bits > 0`; the web client shows the `proving` step and a real account creates
  end-to-end; the proof takes roughly the calibrated ~30s on a throttled device
  (DevTools CPU throttle is a stand-in). Replaying a consumed nonce →
  `pow_invalid`.
- **Switch ON (magic value):** boot logs the loud warning; registration is
  instant; e2e green.
- **Fail-closed check:** set the env var to a *wrong* value → PoW stays on
  (`bits > 0`), confirming a typo can't silently disable it.
- Confirm the credential-KDF path is unchanged (the PoW is a separate Argon2
  use; `valid_kdf_params` and `derive_secret` untouched).

## Out of scope

- In-process rate limiting (`rocket-governor`) — complementary defence-in-depth,
  its own future ADR (ADR-0020 says so explicitly).
- Behavioural / fingerprint detection, device attestation / Private Access
  Tokens, email/phone verification — all rejected in ADR-0020's alternatives.
- Sharing the nonce store across instances — single-instance today; the
  shared-state migration is the same future ADR as the EventHub / keyed mutex.
- A progress bar for the grind beyond the `proving` step label — a single
  occasional progress postMessage can be added later if the opaque wait feels bad.
