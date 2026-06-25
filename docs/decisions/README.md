# Architecture Decision Records (ADRs)

This directory contains Architecture Decision Records (ADRs).

ADRs capture **why** a significant technical decision was made, not how it is implemented.
They exist to preserve context over time.

## When to write an ADR

Write an ADR when a decision:

- introduces a new dependency or service
- changes a trust or security boundary
- affects storage layout or data ownership
- would be hard to reverse later

Do **not** write ADRs for routine refactors or obvious choices.

## Format

Keep ADRs short (1–2 pages max) and concrete.

Recommended structure:

- **Context**: what problem we are solving
- **Decision**: what we chose
- **Consequences**: trade-offs, limitations, follow-up work
- **Alternatives considered**: brief list, not an essay

## Naming

Use sequential numbering:

```
adr-0001-short-title.md
adr-0002-short-title.md
```

Numbers are monotonically increasing.  
Never renumber or rewrite old ADRs — add a new one if the decision changes.
**Narrow exception:** an ADR accepted prematurely that never shipped and was
never relied upon may be overwritten rather than superseded — pragmatism over
ceremony, not license to rewrite load-bearing history.

## Status

An ADR may be:

- **Draft** (proposed, not yet accepted)
- **Accepted** (default)
- **Superseded** (by a newer ADR)
- **Deprecated** (no longer relevant)

If superseded, link to the replacing ADR at the top.

**Flip to Accepted only after verifying the decision is feasible.** Don't
enshrine an assumption that an external dependency supports what the decision
needs — check it first. (ADR-0025 was first accepted assuming a host could serve
an apex domain; it couldn't, and was overwritten.) Accepting on optimism is how
a rewrite happens.

## Tone

ADRs are factual and pragmatic.
They are not marketing documents or postmortems.
