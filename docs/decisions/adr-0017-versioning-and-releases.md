# ADR-0017: Versioning and release process

Status: Draft — work in progress, not settled

Date: 2026-05-31

> **⚠️ WIP.** This ADR captures the current state of thinking only. The
> decision below is provisional, may change, and may be discarded entirely.
> It records just the tag/milestone decoupling so far; the full release process
> (open items below) is unwritten.

## Context

Git tags `v0.1.0`–`v0.1.12` were cut while the `mvp-v0.1` milestone was still
incomplete, so the tag minor and the milestone number no longer line up — there
is no clean `v0.1.0` that marks "mvp-v0.1 done". Renumbering would mean rewriting
published tags (the GHCR pipeline keys off them) and renaming a *frozen* spec
that two ADRs reference. The fix costs more than the mismatch.

## Decision

Tags and milestones are independent tracks; they are not required to align.

- **Git tags** are a monotonic build counter (`v0.MINOR.PATCH`). Never rewritten.
  Pre-1.0, they carry no compatibility contract.
- **Milestone names** (`mvp-v0.1`, `mvp-v0.2`, …) live in `docs/specs/` and float
  independently of the tag number.

The gap is accidental (tags cut ahead of the milestone); it stays uncorrected to
avoid rewriting published history.

## Consequences

- No published tag, frozen spec, or ADR is touched.
- A reader cannot infer milestone completion from a tag number — milestone status
  lives in the spec's frozen/draft marker instead.

## Open items (TBD)

To be defined as this ADR matures, expected around the `v0.2.0` boundary:

- [ ] When a minor is bumped vs. a patch (e.g. tie minor to a spec freezing).
- [ ] How changelog / release notes are generated from Conventional Commits.
- [ ] Where release notes live (`CHANGELOG.md`, GitHub Releases, or both).
- [ ] What cutting a release does (tag, build, publish — and in what order).

## Alternatives considered

- **Renumber milestones (`mvp-v0.1`→`v0.2`, …):** rewrites immutable ADRs and a
  frozen spec, and still mismatches history (the renamed milestone shipped under
  `v0.1.x`). Rejected.
- **Retag history to `v0.0.x`:** destroys published refs the build pipeline
  depends on, for a cosmetic gain. Rejected.
