# ADR-0016: Server-enforced Argon2id floor

Status: Accepted
Date: 2026-05-30

Refines [adr-0011](adr-0011-credential-derivation.md). Derivation is unchanged;
this moves the Argon2id *floor* from a client convention to a server invariant.

## Context

The KDF params live on `profile.json` (public), and the auth public key is too —
so anyone who can read S3 has an offline brute-force oracle (`guess → Argon2id →
derive → compare`). Argon2id cost is the only barrier, and ADR-0011 left the
floor on the *client*: the server checked only sanity bounds (`m≥8`). A stale or
tampered client could register an account crackable in seconds, indistinguishable
from a strong one, and rotation could silently downgrade an existing account.

## Decision

The server owns the floor. `validKDFParams` rejects anything below
`m=65536, t=3, p=1`, enforced identically at registration and at
`POST /v1/rotate-keys`. The client `DEFAULT_KDF` is now advisory; the server
check is the guarantee. Upper bounds (`m≤1 GiB, t≤16, p≤8`) stay — they only
refuse params that pin unrealistic client-side cost (the server never runs
Argon2id, so attacker-chosen params can't burn server resources).

## Consequences

- No client can register or rotate below production strength, and the server can
  prove it from the stored params alone.
- Existing accounts created under ADR-0011's defaults already meet the floor — no
  migration.
- The floor and the client default must move together; raising one without the
  other rejects the stock client.

## Alternatives considered

- **Keep the floor on the client (status quo):** the guarantee then depends on
  client honesty — the gap this ADR closes. Rejected.
