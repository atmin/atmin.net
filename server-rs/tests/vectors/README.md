# Golden vectors

Cross-language interop fixtures for the phase-1 spike (ADR-0018,
`tasks/rust-backend-spike.md` step 1). Committed regression guards.

- **Go-emitted** — tokens, an auth-proof (`pubkey`, `payload`, `signature`,
  `jcs_canonical` hex), and a CBOR archive blob (hex) + decoded values.
  Produced by a fixed-seed emitter in `server/` (no `time.Now()` in committed
  output). Asserts Rust reproduces/verifies the Go formats.
- **TS-emitted** — `canonicalize()` output (hex) for the same payload battery,
  so the JCS canonical bytes are checked against the *production* signer too.
  Mirrors the existing `web/e2e/fixtures/jcs-rotation-vector.*` pattern.

Empty until step 1 lands the emitters.
