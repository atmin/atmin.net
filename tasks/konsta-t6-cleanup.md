# Konsta migration T6 — shadcn retirement + final pass

> Part of the **Konsta UI migration** ([ADR-0023](../docs/decisions/adr-0023-konsta-ui.md)).
> **Last** — runs once T1–T5 have moved every surface. Removes the dead shadcn
> footprint and closes the migration out.

## Goal

Delete what the migration made unused, take the final measurements, and accept
the ADR.

## Scope

- **Remove unused shadcn primitives** in `web/src/components/ui/` (`alert`,
  `button`, `card`, `checkbox`, `AuroraBackground`) — only those with zero
  remaining importers. Verify with a grep before each deletion.
- Delete `AuroraBackground.stories.tsx` (Aurora killed in T3).
- Drop `@import "shadcn/tailwind.css"` from `index.css` **if** fully unreferenced;
  drop `tw-animate-css` if unused.
- Retire `Layout.tsx` / `PageContent.tsx` (+ their stories) if every screen now
  uses Konsta `Page` — otherwise document what still needs them.
- Remove any leftover shadcn-specific theme tokens in `index.css` that nothing
  uses (keep what Konsta + bespoke elements still reference).

## Final pass

- **Bundle**: `pnpm build`; record the final JS/CSS gzip vs the pre-migration
  baseline and vs the ADR-0023 spike estimate (~+24 kB first screen) — update the
  ADR's consequences with the real number.
- **Full e2e** + **Storybook visual sweep** across ios/material × light/dark.
- Flip **[ADR-0023](../docs/decisions/adr-0023-konsta-ui.md) Draft → Accepted**
  (record any details learned during the build).
- Retire the `konsta-spike` branch (its findings are now in the ADR).

## Done when

- No dead shadcn code remains (or what stays is documented); `index.css` imports
  trimmed; `make fmt lint`, `pnpm tsc`, `pnpm build`, full e2e all green; ADR-0023
  Accepted with the final bundle number.
