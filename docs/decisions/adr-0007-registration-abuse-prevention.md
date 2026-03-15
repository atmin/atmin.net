# ADR-0007: Registration abuse prevention

Status: Draft
Date: 2026-03-15

## Context

Users currently register without any challenge. The system generates a BIP39
handle and returns a device token immediately. This makes bulk bot registration
trivial — a single script can create unlimited accounts with no cost.

The system needs to raise the cost of automated registration while preserving
the privacy-first design ([ADR-0001](./adr-0001-sync-first-s3-mailbox.md)):
no email, no phone, no PII collection.

Two separate concerns are often bundled together but should not be:

1. **Abuse prevention at registration** — stop bots from creating accounts at scale
2. **User notifications** (deletion warnings, security alerts) — requires a contact
   channel like email, which can be added independently and optionally later

This ADR addresses only (1).

## Decision

Registration requires two challenges: a proof-of-work puzzle (raises compute cost)
and a CAPTCHA token (raises interaction cost). Both resolve in the background —
no blocking UX step.

### Proof-of-work

The server issues a challenge; the client must find a value that produces a
SHA-256 hash with a required number of leading zero bits.

**Challenge endpoint: `GET /v1/register/challenge`**

Returns:
```json
{
  "nonce": "random-32-bytes-hex",
  "difficulty": 20,
  "expires_at": "2026-03-15T12:05:00Z"
}
```

The client computes `SHA-256(nonce || solution)` until the result has
`difficulty` leading zero bits. At difficulty 20, this takes ~1 second on a
modern device. The server verifies in one hash operation.

Challenges expire after 5 minutes to prevent stockpiling. The nonce is signed
with the server secret (HMAC) so the server does not need to store issued
challenges — it re-derives and verifies on submit.

Difficulty is configurable via `POW_DIFFICULTY` environment variable and can
be raised dynamically if abuse is detected.

### Test mode

All registration challenges (PoW, CAPTCHA, and any future rate limits) can be
disabled via `REGISTRATION_CHALLENGES=false`. This exists solely for end-to-end
automated testing — never enabled in production. When disabled, the register
endpoint accepts requests without `pow_nonce`, `pow_solution`, or
`captcha_token`.

### CAPTCHA

Cloudflare Turnstile — invisible in most cases, privacy-respecting (no Google
tracking), free tier sufficient. The client embeds the Turnstile widget, which
produces a token. The server verifies it with one HTTP POST to Cloudflare.

### Modified registration flow

**`POST /v1/register` (modified)**

```json
{
  "device_label": "Alice's laptop",
  "auth_public_key": "...",
  "sharing_public_key": "...",
  "pow_nonce": "server-issued nonce",
  "pow_solution": "client-computed value",
  "captcha_token": "turnstile-token"
}
```

Server behavior:
1. Verify HMAC on `pow_nonce` (not expired, issued by this server).
2. Verify `SHA-256(pow_nonce || pow_solution)` has required leading zeros.
3. Verify `captcha_token` with Cloudflare Turnstile API.
4. If all pass, proceed with registration as before (generate user_id, handle, token).
5. If any fail, return `400 challenge_failed`.

### UX flow

```
User fills form → Turnstile runs invisibly → Client solves PoW in background →
Submit all together → Account ready
```

No email to check, no verification screen, no blocking step. Both challenges
typically resolve before the user finishes filling in the form.

## Consequences

### Requires

- New `GET /v1/register/challenge` endpoint (~20 lines).
- PoW verification in `handleRegister` (~10 lines).
- Turnstile verification in `handleRegister` (one HTTP call, ~15 lines).
- Cloudflare Turnstile site setup (free tier).
- Frontend: embed Turnstile widget, run PoW solver in a Web Worker.
- New environment variables: `REGISTRATION_CHALLENGES` (true/false),
  `POW_DIFFICULTY`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET`.

### Positive

- **No PII** — no email, phone, or personal data collected or stored.
- **No new infrastructure** — no email service, no token storage, no TTL cleanup.
- **Non-blocking UX** — registration remains a single step from the user's
  perspective. No "check your email" screen.
- **No new failure modes** — no email deliverability issues, spam folders, or
  provider outages. PoW is pure local compute; Turnstile is a single API call
  with graceful degradation.
- **Tunable** — difficulty adjustable without code changes.
- **Covers complementary vectors** — PoW stops cheap bulk scripting; CAPTCHA
  stops automated interaction. Together they raise both compute and interaction
  cost.

### Negative

- **No user contact channel** — cannot send deletion warnings or security
  alerts. Users whose accounts are cleaned up under [ADR-0006](./adr-0006-data-retention.md)
  receive no notice.
- **PoW is weaker against GPU farms** — a 20-bit puzzle taking 1s on CPU takes
  ~1ms on a modern GPU. Mitigated by CAPTCHA (bots can't easily solve both),
  but a well-resourced attacker with CAPTCHA-solving services can still
  register at moderate cost (~$2-5 per 1000 accounts).
- **Mobile battery impact** — PoW solver consumes CPU. At difficulty 20 this is
  ~1 second of computation, negligible. Higher difficulties would need testing
  on low-end devices.
- **Turnstile is a third-party dependency** — Cloudflare outage blocks
  registration. Mitigated by making CAPTCHA optional server-side
  (`TURNSTILE_ENABLED=true|false`) so it can be disabled without a deploy.

### Deferred

- Device attestation (Apple App Attest / Google Play Integrity) — proves
  registration comes from a real device running the real app binary.
  Raises attacker cost from compute/interaction to physical hardware.
  Requires native apps; not applicable to web clients.
- Server-side anomaly detection — flag accounts that exhibit bot-like
  patterns post-registration (e.g., bulk messaging within seconds of
  creation). Better handled as rate limiting / heuristics than as a
  registration gate.
- Email collection (optional, for deletion notifications and security alerts).
- Adaptive difficulty (auto-increase on registration rate spikes).
- Memory-hard PoW (e.g., Argon2-based) to reduce GPU advantage.
- IP-based rate limiting on `/v1/register`.

## Alternatives considered

### Email verification

Rejected. Adds PII storage, email service dependency, blocking UX step, and
new failure modes (deliverability, spam filters, typos). Abuse prevention is
undermined without rate limiting and disposable email blocking. Email can be
added later as an optional contact channel if deletion notifications prove
valuable.

### Phone verification

Rejected. Phone numbers are more personally identifying than email, carry
carrier SMS costs, and have uneven global coverage.

### CAPTCHA only (no PoW)

Rejected. CAPTCHA-solving services exist at ~$2-5 per 1000 solves. Adding PoW
makes each solve cost compute time on top of the CAPTCHA fee, compounding the
attacker's expense.

### PoW only (no CAPTCHA)

Rejected. GPU-accelerated bots can solve PoW puzzles orders of magnitude faster
than legitimate users on phones. CAPTCHA adds an interaction cost that hardware
cannot easily bypass.

### Time-gated activation

Rejected. A fixed delay (e.g., 10 minutes before first message) punishes the
most natural onboarding flow: register → message friend immediately. Any delay
long enough to inconvenience bots is long enough to frustrate real users, and
bots can trivially sleep through it. Post-registration behavior is better
handled by anomaly detection than by a time gate.
