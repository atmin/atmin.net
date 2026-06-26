# <img src="web/public/favicon.svg" height="28" alt=""> atmin.net

A sync-first, end-to-end encrypted messenger with a stateless Rust backend and client-owned data.

![Rust](https://img.shields.io/badge/Rust-000000?style=flat-square&logo=rust&logoColor=white) ![React 19](https://img.shields.io/badge/React_19-61DAFB?style=flat-square&logo=react&logoColor=black) ![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white) ![WASM](https://img.shields.io/badge/WASM-654FF0?style=flat-square&logo=webassembly&logoColor=white) ![vodozemac Megolm](https://img.shields.io/badge/vodozemac_Megolm-6366f1?style=flat-square) ![S3](https://img.shields.io/badge/S3_compatible-569A31?style=flat-square&logo=amazons3&logoColor=white)

The server is a dumb relay and mailbox — clients own their keys, history, and trust.

No central message database.  
No plaintext on the server.  
No required phone numbers or email addresses.

This project treats documentation as the primary interface — for humans and agents alike.

## Architecture

- End-to-end encryption on the client, browser-first
- Megolm message encryption
- Backup-secret-derived key sharing
- Stateless Rust server
- S3-compatible storage for encrypted messages and media
- Sync-first delivery with explicit offline behaviour
- Invite-based identity discovery

## Status

Early development, but the wire format and storage layout are stable and well-tested — breaking changes are avoided, not expected.

**June 2026** — the backend has been rewritten from Go to Rust ([ADR-0019](docs/decisions/adr-0019-adopt-rust-backend.md)); **v0.1.14** is the first Rust release, **v0.1.13** the last on Go. The HTTP API and S3 storage layout are unchanged, so existing clients are unaffected — live devices stayed authenticated straight through the swap.

To run locally, see [CONTRIBUTING.md](CONTRIBUTING.md).

## The Zen of atmin

[Vision](docs/vision.md) keeps the soul.  
[ADRs](docs/decisions/) keep the why.  
[Specs](docs/specs/mvp-v0.1.md) keep the shape.  
[Invariants](docs/scenarios/invariants/) keep the truth.  
[Tasks](tasks/) keep the next step.  
Tests keep the agent honest.  
Commits keep the story readable.

Simple is better than clever.  
Explicit is better than assumed.  
Boring is better than surprising.  
Small is better than sweeping.  
Reliable is better than impressive.  
Recoverable is better than magical.  
Understandable is better than convenient.  
Documented is better than remembered.  
Tested is better than hoped for.  
Deleted is better than unused.  
Not yet is better than accidental.  
Pragmatic is better than pure.

Agents optimise locally.  
Architecture defines what "better" means globally.

The server is a relay, not a brain.  
The client owns state.  
Message identity is sacred.  
Sync must be idempotent.  
Failure must be explicit.  
User experience must not expose infrastructure nonsense.

A local improvement that breaks [vision](docs/vision.md), [ADRs](docs/decisions/), [specs](docs/specs/mvp-v0.1.md), or [invariants](docs/scenarios/invariants/) is a regression.  
When in doubt, preserve the documented constraints.

## Contributing

This repository is public for transparency and reuse, not collaboration.

I'm not accepting pull requests or feature requests — the maintenance overhead is more than I can take on as a solo project.

You're welcome to fork and adapt under the Apache 2.0 license.

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.