# Releases

The **diary** — a time-stamped record of what shipped in each milestone, the
counterpart to the frontier in [tasks/](../../tasks/README.md). One file per
minor (`v0.N.md`), patches as subsections within it.

This is deliberately *not* a spec and *not* an ADR:

| Doc | Axis | Tense | Mutability |
|---|---|---|---|
| `specs/vN.md` | what the system **does** (surface) | present | overwritten when stale |
| `decisions/` (ADRs) | **why** a choice was made | — | append-only, immutable |
| `releases/vN.md` | what **shipped**, when, at what cost | past | append-only after a tag |
| `tasks/` | what's **next** (frontier) | future | deleted once landed |

Release notes are hand-curated narrative. The automated
changelog-from-Conventional-Commits machinery and the cut process itself remain
open in [ADR-0017](../decisions/adr-0017-versioning-and-releases.md); a release
file may exist (and accumulate) before its tag is cut.

## Index

- [v0.2 — the UI revamp](v0.2.md) — in progress (unreleased).
