# Contributing

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/) format. No scope.

```
type: short imperative description

Optional body explaining why, not what. Bullet points are fine for
multi-part changes.
```

**Types:** `feat` `fix` `refactor` `perf` `ci` `chore` `docs` `revert`

**Breaking change:** append `!` after the type — `feat!:` or `fix!:`.

**Subject line rules:**
- Lowercase, no trailing period
- Imperative mood ("add", "fix", "remove" — not "added" or "fixes")
- Em dash for a subtitle when a bare type isn't enough context: `feat: AuroraBackground — scroll-driven WebGL blob animation`

**Body:** optional, separated by a blank line. Explain *why* the change is needed or summarise non-obvious consequences. Omit when the subject says it all.

---

## Frontend

The web client lives in `web/`. It is a React 19 + TypeScript app, styled with Tailwind CSS v4 and shadcn/ui components, bundled by Vite.

### Gates — every change must pass

```
make fmt   # auto-format and sort imports (Biome)
make lint  # Biome + TypeScript + architecture rules
make test  # Vitest unit tests
```

Run them in that order. `fmt` must come before `lint` (lint errors include formatting violations).

### Architecture

The source is divided into four layers. Imports may only flow downward.

```
routes/ → components/ → lib/
routes/ → hooks/      → lib/
```

Hard rules enforced by `web/scripts/lint-architecture.sh` (runs as part of `make lint`):

| Layer | Rule |
|---|---|
| `routes/` | No `className`. Routes are pure orchestrators — no styling. |
| `hooks/` | Files must be `.ts`, not `.tsx`. No JSX in the behavior layer. |
| `components/` | No `useEffect`, `useCallback`, `useMemo`, `useRef`. `useState` is allowed. Side-effect lifecycle belongs in hooks. |
| `components/` | No value imports from `@/hooks/`. Type-only imports are fine. |
| `lib/` | No imports from `@/routes/`, `@/hooks/`, or `@/components/`. |

### Testing

- All non-visual code (lib/, hooks/) must have unit test coverage.
- Visual components (components/) are covered by Storybook stories, not unit tests.
- Every component in `components/` needs a `.stories.tsx` alongside it.
- E2E tests live in `web/e2e/` and run via `make e2e-local` (requires Docker).

### Storybook

```
make web-storybook   # start dev server on :6006
```

Each component file `Foo.tsx` should have a matching `Foo.stories.tsx` that covers its main states. Stories are the visual specification — write them as the component's expected behaviour under different props, not as a demo.

### Styling

- Tailwind CSS v4 utility classes only. No CSS modules, no inline styles.
- Theme-aware colours via CSS custom properties (`bg-background`, `text-foreground`, etc.). See `web/src/index.css` for the full token set.
- Dark mode is controlled by the `.dark` class on `<html>`. Both modes must work.
- New UI primitives (dialogs, inputs, etc.) should come from shadcn/ui — run the CLI to copy component source into `web/src/components/ui/`, then adjust as needed.
