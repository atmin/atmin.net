# Documentation index

This repo is documentation-first. Specs and decisions are the source of truth.

## Start here

- [Vision](./vision.md)
- [MVP v0.1 spec](./specs/mvp-v0.1.md)
- [Architecture](./architecture.md) (optional, evolves)
- [Decisions (ADRs)](./decisions/) (why we chose things)
- [Evolution notes](./evolution.md) — how the system may evolve, without committing to a roadmap
- [Scenarios](./scenarios/) — step-by-step walkthroughs, also used to generate tests
- [Operations](./ops.md) — infrastructure, deployment, CI

## Working agreements

- Changes are driven by artifacts (specs/ADRs).
- Keep docs short, concrete, and up to date enough.
- Specs describe **what** and **how**; ADRs capture **why**.

## Glossary (minimal)

- **Envelope**: an opaque, end-to-end encrypted payload plus minimal routing metadata. Addressed to a user, not a device.
- **Inbox**: an S3 prefix per user where encrypted envelopes are stored for sync. All of a user's devices read from the same inbox.
- **Sync-first**: delivery is based on syncing inbox objects; realtime is best-effort.
- **Key backup**: Megolm session keys encrypted with the user's backup encryption key, stored on S3. Enables new devices to decrypt history.
- **Backup secret**: a user-held secret (word list or base64) from which auth, sharing, and backup keys are derived. The single root of trust for account ownership and E2E.
- **Compaction**: grouping live immutable objects into daily archive blobs. Triggered by session rotation, executed by any stateless server instance. Idempotent, lock-free.
