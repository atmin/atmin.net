# Registration PoW difficulty — verify it's real off-test, tune & document

> Captured from a live observation: registration on a real browser solved
> "~64 hashes at double-digit ms/hash" — felt trivial. Trivial PoW should only
> happen in `e2e` / `e2e-local`.

## Current (grounded)

- Difficulty is **hardcoded** in [server/src/pow.rs](../server/src/pow.rs):
  `POW_M_KIB = 19_456` (19 MiB Argon2id), `POW_T = 2`, `POW_P = 1`,
  `POW_BITS = 6`. 6 leading-zero bits ⇒ **~64 hashes expected** (~4 s desktop,
  ~30 s on a slow phone, per the code comment).
- The kill switch is **fail-closed**: `DANGEROUSLY_DISABLE_REGISTRATION_POW`
  disables PoW only when it equals exactly `yes-i-am-the-e2e-suite`
  ([config.rs](../server/src/config.rs) `POW_DISABLE_TOKEN`); any other value or
  unset → enabled. Only `make e2e` / `make e2e-local` set it
  ([Makefile](../Makefile)). `make dev` does **not** — dev currently runs real
  PoW.
- Client loop logs `[pow] bits=… m=… solved counter=… in …ms`
  ([web/src/lib/argon2-worker.ts](../web/src/lib/argon2-worker.ts)).

**Reframe:** "64 hashes" is the *enabled* 6-bit target. If PoW were disabled
(`bits=0`) the client would solve in ~1 attempt, effectively instant. So the
observation is consistent with PoW being **on and working** — just quick on a
fast desktop — not with it being trivially disabled. The real question is
whether 6 bits is the cost we want, not whether it was off.

## Change

1. **Confirm, don't assume.** Register against staging/prod with the console
   open; verify the `[pow]` log shows `bits=6` (not `bits=0`) and a real
   `solved counter`. Rules out any deployed env accidentally carrying the
   disable token.
2. **Tune the target (decision).** Decide if 6 bits is the floor. Bumping
   `POW_BITS` raises desktop cost but also punishes low-end phones (already
   ~30 s) — capture the device-time tradeoff before changing. This is an
   [ADR-0020](../docs/decisions/adr-0020-registration-proof-of-work.md) tuning
   call; if changed, note it there.
3. **Document the per-environment matrix** (the actual ask). Prod / staging /
   `make dev` = enabled (6 bits); `e2e` / `e2e-local` = disabled. Home:
   ADR-0020 + the `DANGEROUSLY_DISABLE_REGISTRATION_POW` row in
   [docs/ops.md](../docs/ops.md). Dev easing is optional — indifferent — but
   whatever it does must be written down.

## Verify

- Console log on a real register shows `bits=6` + a non-trivial solve time.
- `grep` the deploy/runtime env to confirm the disable token is absent in
  staging/prod.
- The behaviour matrix is documented and matches reality.
