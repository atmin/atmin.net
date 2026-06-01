# ADR-0017: Versioning and release process

Status: Accepted

Date: 2026-05-31

## Context

Git tags `v0.1.0`–`v0.1.13` were cut continuously while the MVP was built; the
MVP completed at **v0.1.13**, not at a clean `v0.1.0`. That looked like an
off-by-one between the tag minor and the milestone — but it was only an
artifact of tagging *during* the MVP, before there was anything to align to.

## Decision

Milestones are named for the minor version they ship as, and the minor tracks
the milestone from here on.

- **The MVP is the `v0.1.x` line** — named for the product, not pinned to a
  single tag. It shipped across `v0.1.0`–`v0.1.13` and is complete at v0.1.13.
  The spec keeps its `mvp-v0.1` name (frozen, ADR-referenced).
- **Every later milestone is named `v0.2`, `v0.3`, … `v1.0`** and is minted as
  `v0.N.0` when ready (e.g. `v0.2` lands as `v0.2.0`). Its spec lives at
  `docs/specs/v0.N.md`.
- **Minor = milestone; patch = the rolling release counter** within a
  milestone. Tags are a monotonic build counter, pre-1.0 carry no compatibility
  contract, and are never rewritten.

The MVP is the one milestone that didn't start at a clean `.0` (tagging
predated it). Because every later milestone *starts* at `v0.N.0`, the offset is
unique to the MVP and cannot recur.

## Consequences

- No published tag or frozen spec is renumbered; the `v0.1.x` history stands as
  "releases during the MVP," not as an error.
- Milestone status is unambiguous going forward: `v0.N.0` marks the start of
  milestone `v0.N`; the spec's draft/frozen marker tracks its maturity.

## Open items (TBD)

- [ ] How changelog / release notes are generated from Conventional Commits.
- [ ] Where release notes live (`CHANGELOG.md`, GitHub Releases, or both).
- [ ] What cutting a release does (tag, build, publish — and in what order).

## Alternatives considered

- **Renumber milestones / retag history to `v0.0.x`:** rewrites immutable ADRs
  and a frozen spec, and breaks published refs the build pipeline depends on,
  for a cosmetic gain. Rejected — naming the MVP for the product (not a tag)
  dissolves the mismatch without touching history.
