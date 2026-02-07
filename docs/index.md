# Documentation index

This repo is documentation-first. Specs and decisions are the source of truth.

## Start here

- [Vision](./vision.md)
- [MVP v0.1 spec](./specs/mvp-v0.1.md)
- [Architecture](./architecture.md) (optional, evolves)
- [Decisions (ADRs)](./decisions/) (why we chose things)

## Working agreements

- Changes are driven by artifacts (specs/ADRs).
- Keep docs short, concrete, and up to date enough.
- Specs describe **what** and **how**; ADRs capture **why**.

## Glossary (minimal)

- **Envelope**: an opaque, end-to-end encrypted payload plus minimal routing metadata.
- **Inbox**: an S3 prefix where recipient device envelopes are stored for sync.
- **Sync-first**: delivery is based on syncing inbox objects; realtime is best-effort.
