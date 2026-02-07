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

## Status

An ADR may be:

- **Accepted** (default)
- **Superseded** (by a newer ADR)
- **Deprecated** (no longer relevant)

If superseded, link to the replacing ADR at the top.

## Tone

ADRs are factual and pragmatic.
They are not marketing documents or postmortems.
