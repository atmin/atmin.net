# ADR-0019 — Adopt the Rust backend, retire Go

**Date:** 2026-06-11
**Status:** Accepted
**Relates to:** [ADR-0018](./adr-0018-rust-backend-experiment.md) (the experiment this adopts), [ADR-0010](./adr-0010-logging.md) (logging conformance follow-up), [ADR-0007](./adr-0007-registration-abuse-prevention.md) (abuse-resistance, now unparked), [vision.md](../vision.md) (stateless server)

---

## Context

ADR-0018 ran the Rust port as a spike with a decision-pointed exit criterion: pass
the full e2e + invariant suite **unmodified**, with the spec absorbing anything the
port forced to be made explicit. That bar is met:

- The unmodified Playwright suite (scenario + fault-injection invariants) passes —
  **5 consecutive deterministic runs** against the Rust server + real MinIO.
- Cross-implementation interop is proven three ways: golden-vector conformance
  (token / JCS / CBOR vs Go *and* TS), a local Go↔Rust hot-swap against a shared
  bucket, and — decisively — on **staging**, where live Go-authenticated devices
  survived the backend swap invisibly and read Go-written history, CBOR archives, and
  `key_chain.json` without a hitch.
- The divergences the port surfaced (JCS > 2⁵³, CBOR int/double, ULID-strict ids) are
  recorded in ADR-0018; none is reachable by the current protocol.

The question ADR-0018 posed — *can the backend be Rust, as a faithful drop-in?* — is
answered: yes.

## Decision

Adopt the Rust server as the deployed backend and retire the Go server. The codebase
becomes **TypeScript + Rust only** (the WASM crypto crate was already Rust). The
cutover mechanics — delete `server/`, rename `server-rs/` → `server/`, fast-forward
merge preserving history, prod tag, wire the cleanup job — live in
`tasks/rust-cutover.md`; this ADR is the *why*, not the *how*.

## Consequences

- **The motivator is realized.** Protocol invariants are modeled as types (newtype
  IDs, `KeyVersion`, the `ApiError` enum, RAII concurrency guards) and checked by the
  compiler — the tighter rails the experiment was for. One fewer language to hold.
- **Costs, accepted.** `aws-sdk-s3` pulls ~400 crates → slower cold CI compile
  (mitigated by `Swatinem/rust-cache`) and a larger image (debian base, ~39 MB vs Go's
  alpine — irrelevant for a rarely-pulled server). Contributors now need Rust.
- **Interop vectors freeze.** Removing Go removes the `GEN_VECTORS` emitter, so the
  committed golden vectors become regression guards validated *against* (no longer
  regenerable from Go); the TS emitter survives. The frozen-ness is intentional.
- **Parked work unparks.** The abuse-resistance plan (Argon2id PoW registration, rate
  limiting — Draft ADR-0007) was gated on "after the Rust port"; that gate is now met.
- **A pre-existing bug, not introduced here.** The key-backup `session_id` S3-key
  defect (backend-agnostic, surfaced by the port's stress test) is the first
  post-cutover fix — `tasks/key-backup-unsafe-session-id-key.md`.
- **Logging conformance deferred.** The Rust server doesn't yet emit ADR-0010's logfmt;
  latent (nothing aggregates logs today), tracked as a post-cutover task.

## Alternatives considered

- **Keep Go.** Zero risk, but forgoes the now-realized motivator and re-buries the spec
  audit. Rejected once the experiment cleared its bar.
- **Run both (half-Go / half-Rust).** Exactly the drift ADR-0018 forbade. The
  fast-forward cutover replaces Go wholesale.
