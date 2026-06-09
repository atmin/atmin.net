# ADR-0018 — Rust backend port (experiment)

**Date:** 2026-06-08
**Status:** Draft — experiment on branch `rust-port-experiment`. Not a commitment to replace the Go server. Phase 1 (interop spike) complete — see Findings.
**Relates to:** [vision.md](../vision.md) (stateless server), [ADR-0001](./adr-0001-sync-first-s3-mailbox.md) (stateless S3 mailbox), [ADR-0009](./adr-0009-native-wrapper.md) (spike-on-a-branch precedent)

---

## Context

The Go backend is small, stateless, and frozen at the v0.1 protocol: ~3,200 lines
of production code, ~4,900 of tests. Its concurrency — Go's headline strength — is
lightly used: one SSE hub (`events.go`), two keyed mutex maps (`handle_mutex.go`,
`rotation_mutex.go`), and two TTL caches (`middleware.go`). All durable state lives
in S3; the server is a relay, not a brain.

Three facts make a Rust reimplementation worth exploring now:

- **The codebase already ships Rust.** `web/crypto/` is a Rust crate compiled to WASM
  (vodozemac Megolm). The repo is already TS + Rust + Go; collapsing the backend into
  Rust makes it TS + Rust, and opens the door to sharing wire-format / verification
  logic between the WASM crate and the server from one canonical definition.
- **There are no production users.** Worst-case data loss is acceptable. This turns the
  work from a *migration* (dominated by byte-compatible interop with deployed clients
  and archived data) into a *reimplementation against a spec* (dominated by reading the
  spec and the conformance suite). The hardest interop risks largely evaporate.
- **Implementation is largely delegated to coding agents.** A language with compile-time
  rails — ownership, exhaustive matching, `Option`/`Result`, no `nil` — gives an agent a
  fast, deterministic oracle to converge against, catching a class of mechanical errors
  before tests run.

### Motivators

1. **Push correctness into the type system.** Rocket's request guards turn the
   `requireAuth` chain into a typed precondition — a handler takes an `AuthedUser` and so
   cannot be dispatched unauthenticated; the unchecked `ctx.Value(...).(string)` assertions
   disappear. `Option<T>` removes the AWS SDK `nil`-pointer surface (`obj.Size != nil`,
   `*out.IsTruncated`).
2. **One fewer language**, with potential shared Rust between client crypto and server.
3. **Tighter rails for agent-driven work** — the compiler converges the agent's mistakes
   instead of the reviewer's time.
4. **A spec audit.** A second independent implementation is the strongest test of whether
   the protocol is actually complete and unambiguous: wherever the Rust port must guess,
   the spec has a hole. This holds even if the experiment never merges.

### Honest scope of the correctness win

The compiler win is real but **narrow**. The bugs this backend is exposed to are
*semantic* — the per-prefix authorization allow-list, the `key_version` cutoff
([ADR-0012](./adr-0012-backup-secret-rotation.md)), idempotency replay — and no compiler
checks those in any language. The compile-time gains concentrate in a band this code
already engineers around (SDK nil pointers, context type assertions, async data races).

So the payoff is **conditional on modeling domain invariants as types**, not on mechanical
translation: newtypes for `UserId` / `DeviceId` / `Handle` / `KeyVersion`; the authorization
result as a value a handler cannot fabricate; the staleness check as a guard type. Mechanical
translation buys the memory-safety rails this code barely needs and leaves the semantic risk
untouched. The test suite barely shrinks — it ports ~1:1 because it is behavioral.

---

## Decision

Run a **parallel, conformance-gated reimplementation** of the server in Rust on
`rust-port-experiment`, in small reviewable steps. The Go server on `master` is untouched.

This ADR is **Draft** and decides only to *explore*. Replacing Go is a separate, future
decision — a new ADR the experiment must *earn* by passing the existing language-agnostic
e2e + invariant suite end to end. Until then, master's Go server remains the system of record.

### Approach — small steps, each independently reviewable

1. **Interop spike.** Token HMAC, Ed25519 auth-proof over JCS, one CBOR round-trip.
   Oracle: agrees with the TS client and hand-checked vectors. De-risks everything
   downstream before a line of handler code is written.
2. **Type skeleton.** The newtypes, `APIError` → `IntoResponse`, the `Store` trait + an
   in-memory impl (the `MemStore` equivalent). This is where the "illegal states
   unrepresentable" work for authz / `key_version` is front-loaded.
3. **Stateless handlers, one at a time** — profile, register, send, media presign — each
   gated by porting its Go test 1:1 *and* the matching `docs/scenarios/` e2e.
4. **The S3 `Store` impl** behind the trait (presign, list, batch delete).
5. **Stateful / concurrent last** — SSE hub, keyed mutexes, TTL caches. Hardest Rust and
   the likeliest place an agent produces compiles-but-wrong code; reviewed by hand.
6. **Cutover gate:** the existing Playwright e2e + invariant suite, unmodified, green.

### Candidate stack

`rocket` 0.5 (HTTP) · `aws-sdk-s3` (official) · `ed25519-dalek` + `hmac`/`sha2` (crypto) ·
`serde_jcs` (RFC 8785) · `ciborium` (CBOR) · `ulid` · `rust-embed` (embedded SPA).

Rocket over axum because this app needs almost nothing from the tower middleware ecosystem
(auth and logging only — `requireAuth` is already a hand-rolled closure in Go), while Rocket's
**request guards** map the auth layer one-to-one onto the type system: `requireAuth` becomes a
`FromRequest` guard yielding `AuthedUser`, and the `enforceKeyVersion` split becomes two guard
types rather than a boolean argument. The accepted trade is more proc-macro magic: a thinner
training corpus for agents, and macro-expansion errors that read less directly than
plain-function ones — though `ROCKET_CODEGEN_DEBUG=1` (Rocket's built-in, targeted `cargo
expand`) makes the emitted code inspectable when a downstream type error is opaque, and setting
it in the experiment's build gives agents the expansion to reason about. It helps less with
expansion-time failures (a type that isn't `FromRequest`/`Responder`), where there is no valid
code to emit. Rocket's slow release cadence is a
deliberate correctness-first stance — releases are gated on feature/security/usability parity
and the maintainers fix upstream ecosystem bugs rather than ship over them — which echoes this
project's own Zen rather than signalling neglect, and a frozen-protocol backend needs no new
features. The narrower watch-item is *liveness*, not cadence: that soundness/security advisories
and new-Rust breakages get addressed in reasonable time (a tracker glance, not a blocker).
Lock-in is low regardless — Rocket sits only at the HTTP edge (routing, guards, extraction)
while the crypto, `Store`, and protocol core stay framework-agnostic, so swapping to axum later
would be a contained edge change, not a rewrite.

### Exit criteria — decision-pointed, not open-ended

- **Success** = the Rust server passes the full e2e + invariant suite unmodified, **and**
  the spec has absorbed anything the port forced to be made explicit.
- The experiment either reaches conformance and triggers a **migration ADR**, or it is
  **deleted**. No indefinite half-ported backend drifting against master.

---

## Reconciling with the Zen of atmin

A full rewrite reads as the textbook *sweeping* change. The reconciliation is deliberate,
not incidental.

- **"Small is better than sweeping"** governs the *living system* and a reviewer's ability
  to understand each change to it. "Sweeping" is blast radius, not line count. This work is
  a *parallel* implementation on a branch with a blast radius of **zero** on master by
  construction, and it lands — if it lands — as many small reviewable steps (see Approach),
  never one cutover. It does not spend the budget this line protects.
- **"Tested is better than hoped for"** — the only path to master is the existing
  language-agnostic conformance suite. Conformance-proven or nothing.
- **"Documented is better than remembered"** — the experiment's primary product is a
  hardened spec: a second implementation surfaces every gap and ambiguity in the protocol.
- **"Explicit is better than assumed"** — types force the protocol's implicit assumptions
  (`nil`, `key_version`, prefix authz) into the open, *given* the type-modeling above.
- **"Recoverable is better than magical"** — no users, acceptable data loss, `git branch -D`
  undoes everything.
- **"Not yet is better than accidental"** is the *governing* constraint, and it is honored
  by splitting the decision: explore *now*, decide to *replace* later via a separate ADR.
  The risk this line guards against — a half-finished backend lingering and rotting — is
  bounded by the Exit criteria. Left open-ended, the experiment would violate both this line
  and "Deleted is better than unused"; decision-pointed, it does not.

No vision, ADR, spec, or invariant names the implementation language. README's "stateless
Go backend" is descriptive; vision's "stateless … server" is language-neutral. The port is a
regression only if it breaks a *documented constraint* — and by construction it must satisfy
all of them.

---

## Consequences

- `master` is unaffected throughout; full recoverability by deleting the branch.
- **The spec hardens regardless of outcome.** A failed experiment still pays back as a
  protocol-completeness audit — the cheapest reason to run it.
- A maintenance tax accrues if the branch lingers; the Exit criteria bound it.
- If it merges, the repo simplifies to TS + Rust and the server can begin sharing types with
  the WASM crypto crate — a follow-up, not part of this experiment.

---

## Findings (phase 1)

**Outcome — the interop risk that gated this experiment is retired.** All three
wire formats interoperate with the Go server: device tokens are byte-identical and
parse/verify Go tokens; a Go-signed Ed25519 auth proof verifies in Rust, with JCS
canonical bytes matching *both* `gowebpki/jcs` and the TS production signer across a
broad battery (full UTF-8, control escapes, slash, exponents); and `ciborium` decodes
and round-trips Go/`fxamacker` CBOR archives. Exactly one divergence surfaced — and
it is contained and unreachable by the protocol. The two findings below record it and
the CBOR encoding properties a Rust reader must respect. Verified by the 7 unit + 10
interop tests in `server-rs`. Phase 2 (type skeleton) is unblocked.

- **JCS number canonicalization diverges beyond 2⁵³.** `serde_jcs` preserves JSON
  integers larger than 2⁵³ exactly (`10000000000000001`), whereas `gowebpki/jcs` —
  and the TS `canonicalize` signer, since JS numbers are IEEE-754 doubles — round to
  the nearest double (`10000000000000000`), as RFC 8785 requires. Every other tested
  form agrees byte-for-byte: full UTF-8 incl. 4-byte/astral (`😀 𝄞`), Cyrillic, Kanji,
  control-char short escapes, `/`, and the float/exponent forms `1e21`→`1e+21`,
  `1e-7`, `-0`→`0`, `1.0`→`1`.
  - *Impact on the current protocol: none.* Signed payloads (auth proofs, rotation
    continuity) carry only strings and a small-integer `key_version`, well within the
    JS-safe range. The divergence is unreachable by current inputs. Verified: the
    `go_and_ts_agree` interop test shows the production signer (`canonicalize`) and the
    Go verifier (`gowebpki/jcs`) agree on *every* battery case — so `serde_jcs` is the
    sole outlier, and only for inputs the protocol never produces.
  - *Recommended constraint:* any JSON value signed over its JCS bytes should be
    restricted to strings, booleans, null, and integers in ±(2⁵³−1) — no
    floating-point, no large integers. Pinned by `jcs_known_number_divergence_pinned`
    in `server-rs/tests/interop.rs`, which flips if `serde_jcs` ever changes.
  - *Placement (decided):* this constraint lives **only here, in ADR-0018** — not in
    the spec. `mvp-v0.1` is frozen (ADR-0017) and the protocol is not wrong today (safe
    inputs only). Promote it to a normative spec line only if the port is adopted, or if
    a future signed field could carry numbers — not before.

- **CBOR archives are non-canonical and store JSON numbers as doubles.** Compaction
  `json.Unmarshal`s live objects into `any` (numbers → `float64`) before `cbor.Marshal`,
  so numeric fields like `v` are CBOR doubles, and map-key order follows Go's randomized
  iteration — archives are *not* canonically encoded. `ciborium` decodes Go/`fxamacker`
  archives correctly (entries, text fields, `msg_id` order) and round-trips them
  semantically; byte-identity is neither expected nor required. The Go `map[any]any`
  vs `map[string]any` split is a Go-internal artifact with no Rust analogue.
  - *Impact: none.* A Rust reader must simply expect floats for numeric fields and not
    assume canonical encoding — both already true of `ciborium`. Verified by
    `cbor_decodes_go_archive` / `cbor_roundtrip_stable`.

## Alternatives considered

- **Keep Go (status quo).** Zero risk; foregoes the spec audit and the TS+Rust consolidation.
  The honest default the moment the experiment stalls.
- **Mechanical Go→Rust translation.** Buys the memory-safety rails this code barely needs and
  leaves the semantic risk (authz, `key_version`) untouched. Rejected in favor of modeling the
  invariants as types — otherwise the experiment's central motivator is unmet.
- **Rewrite in place on master, incrementally.** A live half-Go/half-Rust server is exactly the
  sweeping blast radius the Zen warns against. Rejected — the branch keeps the radius at zero.
