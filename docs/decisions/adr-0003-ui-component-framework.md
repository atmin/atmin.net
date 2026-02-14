# ADR-0003: UI component framework

Status: **In Progress**
Date: 2026-02-13

## Context

The web client needs interactive UI components (dialogs, menus, toasts, form inputs)
and eventually a markdown-capable message composer. Building these from scratch would
be an unwise spending of innovation tokens -- accessibility, keyboard navigation, focus
management, and touch handling are hard, solved problems.

We currently have React 19 + Tailwind CSS v4. Tailwind is negotiable -- if the chosen
framework provides its own design system, Tailwind may be redundant.

The app is a lightweight E2E encrypted messenger. Bundle size matters because the crypto
layer already adds weight. Mobile support is critical.

## Decision

TBD -- evaluating options below.

## Options: Component Framework

### shadcn/ui (Radix + Tailwind)

Not a dependency -- CLI copies component source into your project. Built on Radix
Primitives (accessibility) + Tailwind (styling). ~50-60 components. You own the code.

- **Styling:** Tailwind (required)
- **A11y:** Excellent (Radix-grade WAI-ARIA, keyboard nav, focus management)
- **Bundle:** Minimal -- no framework overhead, just Radix primitives (~2-10 kB/component)
- **Coverage:** Dialogs, toasts (Sonner), menus, form inputs, tooltips. No virtualization.
- **Mobile:** Basic -- correct pointer events via Radix, responsive layouts via Tailwind
- **Popularity:** ~8M downloads/week (underlying Radix packages)

Keeps our existing Tailwind setup. Lightest option. No virtualization (need tanstack-virtual
for message lists).

### React Aria (Adobe)

Unstyled components + hooks. 50+ components. Best-in-class accessibility and mobile/touch
handling. Built-in Virtualizer (unique among options).

- **Styling:** Bring your own (works naturally with Tailwind or any CSS)
- **A11y:** Gold standard -- WCAG 2.1, tested across screen readers, adaptive interactions
- **Bundle:** ~15-30 kB gzipped (tree-shakeable)
- **Coverage:** Dialogs, toasts (new 2025), menus, form inputs, tooltips, **Virtualizer**
- **Mobile:** Best -- detects input modality, adapts behavior (long-press menus, etc.)
- **Popularity:** ~700k/week (components), ~1.76M/week (hooks)

Heavier than shadcn/ui but includes virtualization. More styling work upfront. Steeper
learning curve. Smaller community/ecosystem.

### MUI v6

Full styled library. Material Design defaults. ~60+ components. Emotion CSS-in-JS runtime
(Pigment CSS opt-in for zero-runtime).

- **Styling:** Own system (Emotion). Tailwind coexistence = two mental models + layer config
- **A11y:** Good (WCAG 2.1 AA target)
- **Bundle:** Heavy (~90-100 kB gzipped typical usage + Emotion runtime)
- **Coverage:** Most comprehensive. Dialogs, snackbars, menus, all form inputs, data grid
- **Mobile:** Good (mobile-first breakpoint system)
- **Popularity:** ~4.1M/week

Heaviest option. Would likely drop Tailwind (redundant). Strong Material Design opinion --
deviating requires fighting the framework. Note: MUI team released **Base UI v1.0** (Feb 2026),
a separate headless library with 35 components, positioned as Radix successor.

### Mantine v7

Full styled library. 100+ components + 50+ hooks. Native CSS (dropped Emotion in v7).
Built-in notifications, spotlight, form management, tiptap integration.

- **Styling:** CSS Modules + CSS variables. Tailwind coexistence possible but friction
- **A11y:** Good (WAI-ARIA, keyboard nav, tested with jest-axe)
- **Bundle:** ~30-50 kB gzipped JS + CSS file
- **Coverage:** Kitchen-sink. Includes notification system, modals manager, date pickers
- **Mobile:** Good (responsive breakpoints, container queries)
- **Popularity:** ~500k/week

Would likely drop Tailwind. Opinionated visual design. Large dependency surface even for
few components.

### Headless UI v2 (Tailwind Labs)

Unstyled primitives designed for Tailwind. Only ~17 components.

- **Styling:** Designed for Tailwind
- **A11y:** Good (WAI-ARIA, uses React Aria hooks internally)
- **Bundle:** Light (small component set)
- **Coverage:** **Too limited** -- no toasts, no tooltips, no slider, no progress
- **Mobile:** Good (smart touch handling via React Aria)
- **Popularity:** ~1.8M/week

Disqualified by limited component coverage. Missing essentials for a messenger.

### Radix Primitives (standalone)

What shadcn/ui wraps, without the pre-styling. ~30+ unstyled components.

- Effectively shadcn/ui minus the Tailwind classes. More work, same accessibility.
- Note: original Radix maintainers joined MUI; Base UI positioned as successor.
- If using Radix, shadcn/ui is strictly better (same primitives + free styling).

## Options: Message Composer

Start with a plain `<textarea>` + `marked` for rendering. Upgrade path:

### textarea + marked (start here)

- **Bundle:** ~12 kB (marked) + 0 (native textarea)
- **Mobile:** Perfect (native element)
- **Compact input:** Trivial (rows="1" + auto-resize)
- **Markdown:** Source editing, rendered on display. No syntax highlighting in input.
- **Shortcuts:** DIY (~50 lines for Ctrl+B/I/K)

How Discord and Reddit originally worked. Minimal, proven, zero risk.

### Tiptap (upgrade path)

- **Bundle:** ~30-45 kB gzipped (headless, tree-shakeable)
- **Mobile:** Good (v3.0 explicit mobile improvements)
- **Compact input:** Best fit -- headless means you build exactly the chat input you want
- **Markdown:** WYSIWYG with `tiptap-markdown` for serialization. Input rules auto-convert
  `**bold**` as you type.
- **Shortcuts:** Built-in (Ctrl+B/I/K and more)

Best option if we want Slack-like WYSIWYG composer. Headless = style it as compact input.
Mantine includes `@mantine/tiptap` integration if we go that route.

### CodeMirror 6 (alternative)

- **Bundle:** ~40-50 kB gzipped (minimal markdown setup)
- **Mobile:** Good (v6 rework for mobile)
- **Compact input:** Doable with effort
- **Markdown:** Source editing with excellent syntax highlighting
- **Shortcuts:** DIY

Best if users are technical and we want raw markdown with syntax highlighting.

### Not recommended

- **MDXEditor** -- 851 kB gzipped, document-oriented
- **Milkdown** -- document-editor paradigm, poor chat fit
- **Monaco** -- 4 MB+, broken mobile support

## Analysis

The real choice for component framework is between two approaches:

**A) shadcn/ui** -- Keep Tailwind, copy-paste components, lightest bundle, largest
ecosystem. Add tanstack-virtual for message list. Styling is already done for you.

**B) React Aria** -- Drop or keep Tailwind, best accessibility + mobile, built-in
virtualization. More upfront styling work. Smaller community.

**C) Mantine** -- Drop Tailwind, get everything out of the box including tiptap
integration. Medium bundle. Risk: opinionated styling may need fighting later.

For message composer: start with textarea + marked (zero risk), upgrade to Tiptap
when WYSIWYG becomes a priority.

## Leaning

TBD -- need to weigh:
- Is built-in virtualization (React Aria) worth the smaller ecosystem?
- Is Mantine's batteries-included approach worth the styling opinions?
- Is shadcn/ui's Tailwind + copy-paste model the right balance of control and speed?

## Consequences

TBD pending decision.

## References

- [shadcn/ui docs](https://ui.shadcn.com)
- [React Aria](https://react-aria.adobe.com)
- [MUI v6](https://mui.com)
- [Mantine v7](https://mantine.dev)
- [Base UI v1.0](https://base-ui.com) (new, from MUI team + ex-Radix maintainers)
- [Headless UI](https://headlessui.com)
- [Tiptap](https://tiptap.dev)
- [CodeMirror 6](https://codemirror.net)
