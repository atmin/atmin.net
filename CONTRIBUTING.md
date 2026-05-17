# Contributing

This file is the entry point for any human or agent working on the repo.
Read it first; it points at the canonical specs/ADRs/scenarios for everything else.

## Project layout

```
.
├── server/           Go HTTP server — stateless S3 proxy + SSE hub
├── web/              React 19 + TypeScript PWA (Vite)
│   ├── src/          App source (see "Architecture" below)
│   ├── crypto/       Rust crate → WASM (vodozemac Megolm)
│   ├── e2e/          Playwright specs — scenario tests (one per docs/scenarios/*.md)
│   │                 and fault-injection invariant tests (invariants/, docs/scenarios/invariants.md)
│   └── .storybook/   Visual spec for components/
├── docs/
│   ├── vision.md         Goals, non-goals, threat model
│   ├── specs/mvp-v0.1.md Source of truth for protocol/API/storage layout
│   ├── decisions/        ADRs — *why* a decision was made (immutable, append-only)
│   ├── scenarios/        Step-by-step user flows (e2e specs) and system invariants (invariants.md)
│   └── evolution/        Speculative future work, not commitments
├── tasks/            Active TODOs with spec ↔ current ↔ change ↔ verify sections
├── src-tauri/        Native desktop wrapper (ADR-0009)
├── bin/              Build outputs — `bin/atmin` is the server binary
├── scripts/          Repo-wide scripts (e.g. pre-commit hook)
├── Makefile          Single source of truth for every command (CI calls these)
└── docker-compose.yml MinIO for local dev/e2e
```

The repo is **documentation-first**. If the spec and the code disagree, fix one of them in the same change — never silently leave the divergence.

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

**Body:** optional, separated by a blank line. Explain *why* the change is needed or summarise non-obvious consequences. Omit when the subject says it all. Keep it short — one to three sentences maximum.

## Setup

```
make install   # checks toolchain (go, pnpm, cargo, docker, wasm-pack), installs deps, copies pre-commit hook, seeds .env
make dev       # docker compose up MinIO + go run server + pnpm dev for web
```

Required tools: Go (see `server/go.mod`), pnpm, Rust + `wasm32-unknown-unknown`, `wasm-pack`, Docker (for MinIO and e2e).

## Gates — every change must pass

Run in this order; `fmt` must come before `lint` because lint flags formatting violations.

```
make fmt    # gofmt + Biome write
make lint   # go vet + Biome + tsc + architecture rules
make test   # go test ./... + Vitest
```

Aggregates: `make all` = `lint test build`. CI runs the same Make targets — if they pass locally, CI passes (modulo deploy).

## Frontend (`web/`)

React 19 + TypeScript, Tailwind CSS v4, shadcn/ui, Vite. Crypto is delivered as WASM from the `web/crypto` Rust crate (built by `make web-wasm`, called transitively from `make web-build`).

### Layered architecture

Imports may only flow downward. Enforced by `web/scripts/lint-architecture.sh` (part of `make lint`).

```
routes/    → components/ → lib/
routes/    → hooks/      → lib/
```

| Layer | Rule |
|---|---|
| `routes/` | No `className`. Routes are pure orchestrators — no styling. |
| `hooks/` | Files must be `.ts`, not `.tsx`. No JSX in the behavior layer. |
| `components/` | No `useEffect`, `useCallback`, `useMemo`, `useRef`. `useState` is allowed. Side-effect lifecycle belongs in hooks. |
| `components/` | No value imports from `@/hooks/`. Type-only imports are fine. |
| `lib/` | No imports from `@/routes/`, `@/hooks/`, or `@/components/`. |
| `hooks/` | No imports from `@/routes/` or `@/components/`. |

`components/ui/` is exempt — shadcn primitives are unmodified vendored code.

### Testing

| What | How | Where |
|---|---|---|
| `lib/` (pure logic) | Vitest unit tests | `*.test.ts` colocated |
| `hooks/` (lifecycle/state) | Vitest unit tests with `@testing-library/react` | `*.test.ts` colocated |
| `components/` (visual) | Storybook stories | `*.stories.tsx` colocated |
| End-to-end flows | Playwright, one spec per `docs/scenarios/*.md` | `web/e2e/` |
| Invariants (fault-injection) | Playwright with deliberate faults; asserts UI + IDB + S3 layers | `web/e2e/invariants/` |

`make e2e-local` runs Playwright against a native Go server + Vite + MinIO; pass `SPEC=...` to scope (e.g. `make e2e-local SPEC=media`). `make e2e` runs the full Docker image (used by CI on tags).

### Styling

- Tailwind CSS v4 utility classes only. No CSS modules, no inline styles.
- Theme-aware colours via CSS custom properties (`bg-background`, `text-foreground`, etc.). See `web/src/index.css` for the full token set.
- Dark mode is controlled by the `.dark` class on `<html>`. Both modes must work — verify in Storybook (`make web-storybook` on `:6006`) before merge.
- New UI primitives (dialogs, inputs, etc.) come from shadcn/ui — run the CLI to copy source into `web/src/components/ui/`, then adjust.

### WASM crypto crate (`web/crypto/`)

`vodozemac` Megolm is wrapped via `wasm-bindgen` and consumed from `web/src/lib/wasm.ts` / `megolm-session.ts`. Rebuild with `make web-wasm` whenever `web/crypto/src/**` changes; `make web-build` does it transitively. The generated `pkg/` is gitignored — build artefacts must not be committed.

## Backend (`server/`)

Single-package Go binary. **Stateless by design**: all durable state lives in S3 — the only in-process state is the SSE hub, the device-existence cache, and the media-quota cache (see ADR-0001 and ADR-0004 for the "in-process now, shared state later" pattern).

### File map

| File | Role |
|---|---|
| `main.go` | Wire-up only: config, S3 client, EventHub, mux, listen. |
| `config.go` | Env-var loading. New env vars must be added here and to `docs/ops.md`. |
| `routes.go` | Route table. Wraps authenticated handlers in `requireAuth`. |
| `middleware.go` | `requireAuth`, `deviceCache`, `logRequests`, `remoteIP`. |
| `handlers.go` | All HTTP handlers + prefix authorization (`authorizeKey`, `authorizeKeyWrite`). |
| `auth.go` | Token (HMAC) + auth-proof (Ed25519) primitives. |
| `events.go` | SSE hub + `last_active` updater. |
| `store.go` | `Store` interface + S3 implementation. |
| `store_mem.go` | `MemStore` for tests — must satisfy the `Store` interface in lockstep. |
| `media_quota.go` | Per-user quota; in-process cache, swappable interface. |
| `error.go` | Canonical `APIError` set. |
| `static.go` | Embedded SPA + client-side-routing fallback. |
| `handle.go` | BIP39 handle generator (collision retry happens at the call site). |

### Style

- Use `slog` for logs (text format, see ADR-0010). Never `fmt.Println`.
- Errors: prefer the canonical `APIError` set in `error.go` (`errBadRequest`, `errForbidden`, …). For ad-hoc internal errors, use the inline form `APIError{http.StatusInternalServerError, "internal", "<context>"}`.
- Authorization is **per-prefix**, enforced inside each handler via `authorizeKey` / `authorizeKeyWrite` / `authorizePrefix`. Keep the allow-list in `handlers.go` in sync with `docs/specs/mvp-v0.1.md` "Storage API".
- HTTP routing uses Go 1.22 mux patterns (`GET /v1/...`). `requireAuth` is a closure, not middleware on the mux — wrap each authenticated handler explicitly so the device-cache is shared.

### Testing

- All handlers use `MemStore` — never spin up real S3 in unit tests.
- Helpers live at the top of `handlers_test.go` (`testServer`, `registerTestUser`, `signAuthProof`, `authedRequest`). Reuse them instead of open-coding.
- Cover golden path **and** authorization rejections for every new endpoint. Other-user-prefix denials are not optional.
- Add a `MemStore` method whenever the `Store` interface changes — both must satisfy the same contract.

### Adding an endpoint — checklist

1. Update `docs/specs/mvp-v0.1.md` (request/response shape, error codes, S3 effects).
2. Add an ADR if the change crosses a trust boundary, introduces a dependency, or affects storage layout (see `docs/decisions/README.md`).
3. Implement the handler in `handlers.go`; wire in `routes.go` (wrap with `auth(...)` if it needs a token).
4. Add a typed wrapper in `web/src/lib/api.ts` and a request type alongside.
5. Tests: handler-level Go test (golden + 400 + 401/403); unit test for the `api.ts` wrapper.
6. If it changes a user-visible flow, update or add a `docs/scenarios/*.md` and a matching `web/e2e/*.spec.ts`.

## S3 layout (canonical — do not drift)

| Prefix | Owner | Notes |
|---|---|---|
| `users/{uid}/profile.json` | server (registration / `PUT /v1/profile`) | Source of truth for profile data |
| `users/{uid}/devices/{did}.json` | server | Existence = device is valid; deletion = revoked |
| `users/{uid}/contacts.json` | client (presigned PUT, AES-256-GCM with backup key) | E2E encrypted |
| `handles/{handle}.json` | server (projection of `profile.json` public fields) | Resolve cache |
| `inbox/{uid}/live/{msg_id}` | server (`POST /v1/send`) | JSON envelope |
| `inbox/{uid}/archive/{date}-{ULID}` | server (`POST /v1/store/compact`) | CBOR array |
| `keys/{uid}/live/{session_id}` | client (presigned PUT) | Encrypted Megolm session key |
| `keys/{uid}/archive/{date}-{ULID}` | server (compaction) | CBOR array |
| `media/{uid}/{ulid}` | client (presigned PUT) | AES-256-GCM ciphertext |

Full schema and lifecycle: `docs/specs/mvp-v0.1.md`.

## Documentation rules

- **Specs** describe *what* and *how* the system behaves. Update the spec in the same PR as the implementation. If a spec section becomes wrong, fix the spec — never leave it as historical record.
- **ADRs** describe *why* — they are append-only and immutable. Create a new ADR (next sequential number) to supersede an old one; do not edit accepted ADRs except to mark them superseded with a link.
- **Scenarios** double as e2e specs. New user-facing flow → new scenario file → matching `web/e2e/*.spec.ts`.
- **Invariants** describe what must hold under adverse conditions (faults, retries, concurrency). Defined in `docs/scenarios/invariants.md`. New invariant → row in the prioritisation table → section using the Statement / Fault construction / Assertions / Permitted divergence template → `web/e2e/invariants/<name>.spec.ts`. See the "Adding a new invariant" checklist at the bottom of that file.
- **Evolution notes** are deliberately speculative; nothing in `docs/evolution/` is a commitment. Don't reference an evolution note as if it were a spec.
- **Tasks** in `tasks/` are intent-to-implement docs. They get deleted once landed. Use the `Spec → Current → Change → Verify` template the existing files use. Keep `tasks/README.md` in sync: update it when adding a task, deleting a landed one, or changing priority order.

Reference style:
- Mermaid diagrams for sequence flows in scenarios.
- Backticks for paths, env vars, and code identifiers.
- ULID-shaped placeholders (`01HWQA…`) — never real values from production.

## Operations

`docs/ops.md` is the canonical infrastructure doc — Scaleway resources, env vars, CORS config, deploy commands, log query recipes (Cockpit / Grafana per ADR-0010). Update it whenever you add an env var, change the deploy pipeline, or modify required infrastructure.

`make build` produces a single self-contained binary that embeds the SPA via `//go:embed dist`. `server-build` copies `web/dist` into `server/dist` first; the Dockerfile does the same in two stages.

## Pre-commit

`make install` copies `scripts/pre-commit` to `.git/hooks/`. It runs `make fmt lint test` and blocks bad commits. Don't bypass with `--no-verify` unless you understand exactly which gate is failing — fix the underlying issue.
