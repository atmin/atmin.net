# ADR-0020 — Registration proof-of-work (memory-hard)

**Date:** 2026-06-12
**Status:** Accepted — implemented & enforced (2026-06, `server/src/pow.rs`; ships in v0.2). Supersedes [ADR-0007](./adr-0007-registration-abuse-prevention.md).
**Relates to:** [ADR-0001](./adr-0001-sync-first-s3-mailbox.md) (no PII), [ADR-0016](./adr-0016-server-enforced-kdf-floor.md) (the _credential_ KDF — distinct from this), [ADR-0019](./adr-0019-adopt-rust-backend.md) (single in-process backend), [ops.md](../ops.md) (EU-resident infrastructure), [evolution/telemetry-and-analytics.md](../evolution/telemetry-and-analytics.md) (registration-rate signal).

## Context

Registration is uncapped: a script can mint unlimited accounts at zero cost.
[ADR-0007](./adr-0007-registration-abuse-prevention.md) (Draft) proposed two gates
— a SHA-256 leading-zero-bits proof-of-work **and** a Cloudflare Turnstile CAPTCHA.
Two problems with that draft, clearer now:

1. **A SHA-256 PoW has the wrong cost asymmetry.** It is trivially parallelised on
   commodity GPUs/ASICs, so the per-account cost to a hardware-equipped attacker is
   far below the cost to a legitimate phone — the puzzle is cheapest for exactly the
   party it should deter.
2. **Turnstile is a non-EU third party on the registration path.** It ships
   per-registration interaction data to a Cloudflare endpoint, conflicting with the
   EU-resident-infrastructure stance ([ops.md](../ops.md)) and adding an external
   dependency and a privacy surface — in a system whose premise is no PII and no
   third-party data egress ([ADR-0001](./adr-0001-sync-first-s3-mailbox.md)).

The backend is now a single in-process Rust service with no load balancer or edge
([ADR-0019](./adr-0019-adopt-rust-backend.md)), so any abuse control must run
in-process. And a meaningful PoW (tuned to seconds) would make the end-to-end test
suite — 100+ registrations/logins per run — unrunnable, while that suite exercises
the _production_ image; a test-time bypass must therefore not weaken production.

## Decision

Replace ADR-0007's two gates with a single **memory-hard Argon2id proof-of-work**,
computed by the client and verified by the server. **Drop Turnstile entirely** — no
CAPTCHA, no third party, no PII, no egress; the control is fully in-process and
EU-resident.

- **Memory-hard, so the asymmetry favours the defender.** Argon2id is RAM-bound, so
  GPUs/ASICs gain little: a phone pays the cost once, a botnet pays it in scarce
  memory _per account_.
- **Server-issued challenge.** `GET /v1/register/challenge` returns a nonce and the
  difficulty (Argon2 parameters); the client computes a proof; registration submits
  it; the server verifies the proof meets the **difficulty it issued**. The client
  cannot lower the difficulty. Nonces are single-use with a short TTL (in-process
  state, per the [ADR-0004](./adr-0004-sse-realtime-notifications.md) "in-process now,
  shared later" pattern).
- **Distinct from the credential KDF.** This PoW is purely an anti-abuse cost. It
  derives no key material and is discarded after verification — entirely separate
  from the Argon2id _credential_ stretch and its floor
  ([ADR-0011](./adr-0011-credential-derivation.md),
  [ADR-0016](./adr-0016-server-enforced-kdf-floor.md)). Consequently **weakening or
  disabling the PoW lowers abuse resistance only — never confidentiality.**
- **Tuning.** Difficulty is set so a proof takes on the order of ~30s on a slow
  device, run in the background; registration is a one-time tax, not a blocking step.
- **Test enablement — a fail-closed runtime switch.** The issued difficulty is gated
  by a server setting. A runtime switch (an environment variable matched against an
  exact magic value, e.g. `DANGEROUSLY_DISABLE_REGISTRATION_POW`) sets the issued
  difficulty to zero, so **both** ends go cheap: the client satisfies a trivial
  challenge and the server accepts it. It is **fail-closed and loud** — any value
  other than the exact token leaves the PoW on, and a warning is logged at boot when
  it is off. The end-to-end suite (local _and_ CI, which runs the production image)
  sets it; production does not.

  This is the opposite mechanism to the KDF floor's test bypass, and deliberately so
  — each control is matched to _stakes × reach_:

  | Control                         | Stakes if weakened          | Reach the test bypass needs             | Mechanism                                                   |
  | ------------------------------- | --------------------------- | --------------------------------------- | ----------------------------------------------------------- |
  | Credential KDF floor (ADR-0016) | high — brute-forceable keys | local only (CI tolerates real KDF cost) | **compile-time** feature, absent from the production binary |
  | Registration PoW (this ADR)     | low — bot spam, recoverable | local **and** CI prod-image run         | **runtime** switch, acceptable in the production binary     |

  A runtime switch is safe _here_ precisely because disabling the PoW cannot weaken
  any user's cryptography; a compile-time-only bypass would not reach the CI
  prod-image run, where the PoW must also be off.

### Proof construction

The scheme is a **leading-zero-bits search with Argon2id as the hash function**,
not a single fixed-work Argon2 hash. A fixed-work proof would force the server to
recompute the full ~30s to verify — a trivial denial-of-service. The search shape
makes verification **one** hash while the client pays many, so both required
properties hold at once: defender/attacker asymmetry (client computes ~`2^bits`
hashes, server computes one) _and_ memory-hardness (every attempt is RAM-bound).

- **Challenge** issues `{ nonce, m, t, p, bits }` — `nonce` is 16 random bytes
  (base64url); `m`/`t`/`p` are Argon2id parameters chosen so a single hash is cheap
  (tens of milliseconds, with `m` small enough that the server's per-verify
  allocation stays modest); `bits` is the required count of leading zero bits.
- **Client** searches `counter = 0, 1, 2, …` for the first value where
  `Argon2id(password = counter_le_bytes, salt = nonce, m, t, p)` has at least `bits`
  leading zero bits. The proof binds to the issued nonce through the salt.
- **Proof** submitted with registration is `{ nonce, counter }`.
- **Server** consumes the nonce (single-use, short TTL, in-process) and recomputes
  that one hash with the **issued** parameters, checking the leading-zero-bits
  target. `bits = 0` (the disabled switch) makes `counter = 0` solve instantly and
  any hash pass.
- **Difficulty** is calibrated so `2^bits × single-hash-time ≈ 30s` on a slow
  device, while keeping the single per-verify hash cheap.

Three handler-level rules follow from this and are part of the decision:

- **Consume the nonce before verifying the proof.** A failed proof still burns its
  challenge, so one issued nonce grants no free retries — a fresh challenge must be
  fetched per attempt.
- **Verify the proof only after cheap input validation** (malformed body, empty
  fields, handle charset/reserved, the credential-KDF floor). A bad request must
  never cost an Argon2 hash; the PoW guards the abuse/expense path, not input
  validation.
- **One rejection code for every proof failure** — unknown, expired, reused, or
  wrong proof all return the same error, so the response is not an oracle for nonce
  state.

## Consequences

- Bulk registration pays a memory-hard cost per account; a legitimate client pays a
  one-time background ~30s. No CAPTCHA, no third party, no PII, no egress —
  consistent with the EU-resident stance.
- A production-reachable switch to disable the PoW exists. Accidental disablement is
  structurally impossible (a typo or wrong value fails to the PoW being on); malicious
  disablement requires deployment-environment control (already a total compromise) and
  yields only spam — detectable (a registration-rate spike) and recoverable.
- Challenge issuance adds a round-trip and a small amount of ephemeral server state
  (nonce validity / replay), alongside the other in-process state.
- The end-to-end suite stays runnable: the PoW is switched off in tests, and the
  credential KDF cost is handled separately (ADR-0016 plus its compile-time test
  feature).
- In-process rate limiting (e.g. `rocket-governor`) is a complementary defence-in-depth
  layer but is **out of scope** for this ADR.

## Alternatives considered

- **SHA-256 leading-zero-bits PoW** (ADR-0007 draft): GPU/ASIC-friendly → poor cost
  asymmetry. Rejected for memory-hard Argon2id.
- **Cloudflare Turnstile / hCaptcha**: a non-EU third party on the registration path,
  sending interaction data off-box; an external dependency and a privacy surface.
  Rejected as incompatible with the EU-resident, no-PII design.
- **Compile-time-only PoW disable** (as used for the KDF floor): cannot reach the CI
  prod-image run, where the PoW must also be off — and a runtime switch is acceptable
  because disabling the PoW is low-stakes. Rejected in favour of the runtime switch.
- **Email/phone verification**: reintroduces PII and a contact channel, against the
  no-PII design ([ADR-0001](./adr-0001-sync-first-s3-mailbox.md)); user notifications
  remain a separate concern, as ADR-0007 already noted.
- **Behavioural / fingerprinting detection** (mouse movement, typing cadence, canvas/
  device fingerprint): rejected on three grounds. It answers the wrong question — the
  threat is *bulk* registration (scale), not whether any one actor is human, and PoW
  taxes scale directly. It is a classifier, so it has false positives: a flagged real
  user is blocked at the door (a worse, unrecoverable failure than a cleanable spam
  account), where PoW imposes a uniform, false-positive-free cost. And it requires
  collecting behavioural/fingerprint data — the same tracking surface the Turnstile
  rejection avoids, against the no-PII / EU-resident stance. It is also
  adversarial-fragile (humanised headless input, CAPTCHA farms step over it). If cheap
  signals are ever used, they may *add* friction (raise difficulty for a suspicious
  session) but must never *block*.
- **Device attestation / Private Access Tokens** (Privacy Pass — a fingerprint-free
  human-presence assertion): the one privacy-preserving option, but it relies on
  Apple/Google as a non-EU third-party attester (the same trust-anchor objection as
  Turnstile) and is platform-gated, silently excluding the privacy-conscious,
  hardened-browser users this system attracts. Rejected for consistency.
