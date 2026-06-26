# Contributing

This file is the entry point for any human or agent working on the repo.
Read it first; it points at the canonical specs/ADRs/scenarios for everything else.

## Project layout

```
.
├── server/           Rust HTTP server (Rocket) — stateless S3 proxy + SSE hub
├── web/              React 19 + TypeScript PWA (Vite)
│   ├── src/          App source (see "Architecture" below)
│   ├── crypto/       Rust crate → WASM (vodozemac Megolm)
│   ├── e2e/          Playwright specs — scenario tests (one per docs/scenarios/*.md)
│   │                 and fault-injection invariant tests (invariants/, docs/scenarios/invariants/)
│   └── .storybook/   Visual spec for components/
├── site/             Static marketing site at the apex atmin.net (Astro) — ADR-0025
├── docs/
│   ├── vision.md         Goals, non-goals, threat model
│   ├── specs/            Milestone specs — source of truth for protocol/API/storage (mvp-v0.1 + v0.2 shipped; v0.3 draft. Milestones from v0.2 on are named for the minor they ship as — see ADR-0017)
│   ├── decisions/        ADRs — *why* a decision was made (immutable, append-only)
│   ├── scenarios/        Step-by-step user flows (e2e specs) and system invariants (invariants/)
│   ├── releases/         The diary — what shipped per milestone, when, at what cost (past tense)
│   └── evolution/        Speculative future work, not commitments
├── tasks/            The frontier — active/upcoming TODOs (spec ↔ current ↔ change ↔ verify); deleted once landed
├── src-tauri/        Native desktop wrapper (ADR-0009)
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
make install   # checks toolchain (pnpm, cargo, docker, wasm-pack), installs deps, copies pre-commit hook, seeds .env
make dev       # docker compose up MinIO + cargo run server + pnpm dev for web
```

Required tools: Rust (stable, see `server/Cargo.toml`) + `wasm32-unknown-unknown`, pnpm, `wasm-pack`, Docker (for MinIO and e2e).

## Gates — every change must pass

Run in this order; `fmt` must come before `lint` because lint flags formatting violations.

```
make fmt    # Biome write + cargo fmt
make lint   # Biome + tsc + architecture rules + cargo fmt --check + clippy
make test   # Vitest + cargo test
```

Aggregates: `make all` = `lint test build`. CI runs the same Make targets — if they pass locally, CI passes (modulo deploy).

## Frontend (`web/`)

React 19 + TypeScript, Tailwind CSS v4, Konsta UI (native-feel iOS/Material chrome — see [ADR-0023](docs/decisions/adr-0023-konsta-ui.md)), Vite. Crypto is delivered as WASM from the `web/crypto` Rust crate (built by `make web-wasm`, called transitively from `make web-build`).

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

`components/ui/` is exempt — the home for unmodified vendored primitives. The
app's native-feel chrome is now Konsta (ADR-0023); the directory is empty after
the migration but stays exempt for any shadcn primitives re-added for bespoke /
desktop-only surfaces (ADR-0023 keeps shadcn available for those).

### Testing

| What | How | Where |
|---|---|---|
| `lib/` (pure logic) | Vitest unit tests | `*.test.ts` colocated |
| `hooks/` (lifecycle/state) | Vitest unit tests with `@testing-library/react` | `*.test.ts` colocated |
| `components/` (visual) | Storybook stories | `*.stories.tsx` colocated |
| End-to-end flows | Playwright, one spec per `docs/scenarios/*.md` | `web/e2e/` |
| Invariants (fault-injection) | Playwright with deliberate faults; asserts UI + IDB + S3 layers | `web/e2e/invariants/` |

`make e2e-local` runs Playwright against a native Rust server + Vite + MinIO; pass `SPEC=...` to scope (e.g. `make e2e-local SPEC=media`). `make e2e` runs the full Docker image (used by CI on tags).

**e2e specs read as prose.** The test body narrates the flow (`registerUser`, `openChat`, `revokeOtherDevice`); `waitForSelector`, raw locators, and cryptic interaction sequences belong behind semantically-named helpers in `web/e2e/helpers.ts`. Extract opportunistically — boy-scout rule: leave each spec you touch a little more readable.

The unit project runs in **node** — DOM is opt-in per file via `// @vitest-environment happy-dom` (line 1). Never rely on an ambient `localStorage`/`sessionStorage`: a test that installs a partial Web Storage global leaks it into sibling files in a reused CI worker (green locally, red in CI). Use the shared `memoryStorage()` from `src/test/storage.ts` with `vi.stubGlobal('localStorage', memoryStorage())` in `beforeEach` and `vi.unstubAllGlobals()` in `afterEach`, so each test owns a fresh Storage and restores it after.

### Styling

- Tailwind CSS v4 utility classes only. No CSS modules, no inline styles.
- Theme-aware colours via CSS custom properties (`bg-background`, `text-foreground`, etc.). See `web/src/index.css` for the full token set.
- Dark mode is controlled by the `.dark` class on `<html>`. Both modes must work — verify in Storybook (`make web-storybook` on `:6006`) before merge.
- New UI primitives (dialogs, inputs, sheets, etc.) come from **Konsta UI** (`konsta/react`) — the native-feel iOS/Material kit (ADR-0023). Compose them with plain Tailwind. shadcn remains available via its CLI for bespoke / desktop-only surfaces (vendored into `web/src/components/ui/`).

### WASM crypto crate (`web/crypto/`)

`vodozemac` Megolm is wrapped via `wasm-bindgen` and consumed from `web/src/lib/wasm.ts` / `megolm-session.ts`. Rebuild with `make web-wasm` whenever `web/crypto/src/**` changes; `make web-build` does it transitively. The generated `pkg/` is gitignored — build artefacts must not be committed.

## Marketing site (`site/`)

The public-facing apex `atmin.net` — static brochureware (Astro + Tailwind v4), separate from the app ([ADR-0025](docs/decisions/adr-0025-marketing-site.md)). No backend, no user data; it links out to the web app and, later, the native/desktop builds. The token palette mirrors `web/src/index.css` so site and app read as one product.

- `make site-dev` / `make site-build` / `make site-check` (deps installed by `make install`).
- It's **independent of the app's gates** — not in `make all/build/lint/test`. `site-build` runs `astro check` as its own gate.
- Deploy is path-filtered CI (`.github/workflows/site.yml`) → GitHub Pages at the apex (free managed TLS); pushing to `master` with `site/**` changes publishes. Pages + DNS setup in [docs/ops.md](docs/ops.md) "Marketing site".

## Backend (`server/`)

Single Rust crate (Rocket 0.5). **Stateless by design**: all durable state lives in S3 — the only in-process state is the SSE hub, the device-existence and profile (`key_version`) caches, the media-quota cache, and the per-key claim mutexes (see ADR-0001 and ADR-0004 for the "in-process now, shared state later" pattern, ADR-0012/0013 for the mutexes).

### File map (`server/src/`)

| File | Role |
|---|---|
| `main.rs` | Binary entry (`#[rocket::main]`): load config, pick the S3 or in-memory store, launch Rocket — or dispatch the `cleanup` subcommand (arg-based, no server). |
| `lib.rs` | Crate root — module declarations; the surface `tests/` integrate against. |
| `config.rs` | Env-var loading (`ServerConfig`, `S3Config::from_env`). New env vars go here **and** in `docs/ops.md`. |
| `routes.rs` | All HTTP handlers **and** the route table — `build(store, config) -> Rocket` (`.mount` + `routes![]`). Per-prefix authorization lives inside each handler. |
| `guard.rs` | `AuthedUser` / `AuthedUserNoKv` request guards (`FromRequest`). A handler does authenticated work only by taking the guard. |
| `token.rs` | Bearer-token (HMAC) mint + verify. |
| `authproof.rs` | Ed25519 auth-proof over JCS-canonical (RFC 8785) bytes (`serde_jcs`) — must match the TS client byte-for-byte. |
| `events.rs` | SSE `EventHub` (RAII subscriptions) + `last_active` updater. |
| `store.rs` | `Store` trait — the storage contract. |
| `store_s3.rs` | `S3Store` — the `aws-sdk-s3` implementation. |
| `store_mem.rs` | `MemStore` for tests — must satisfy `Store` in lockstep. |
| `cache.rs` | TTL caches (device existence, profile `key_version`) — in-process now, shared-state later. |
| `keyed_mutex.rs` | Per-key mutex (RAII guard) serialising handle-claim and profile GET-VERIFY-WRITE (ADR-0012/0013). |
| `idempotency.rs` | Rotation idempotency records (`request_id`, 24h TTL). |
| `media_quota.rs` | Per-user media quota; in-process cache, swappable interface. |
| `model.rs` | Request/response DTOs + domain types (`Handle`, `Profile`) and validation. |
| `paths.rs` | S3 key builders — the canonical prefix layout ("S3 layout" below). |
| `reserved.rs` | Reserved-handle blocklist (embedded `reserved_handles.txt`, ADR-0013). |
| `cbor.rs` | CBOR (de)serialisation for compacted archives. |
| `cleanup.rs` | Data-retention sweep — the `cleanup` subcommand's logic (ADR-0006). |
| `spa.rs` | Embedded-SPA serving + client-side-routing fallback (rust-embed, behind the `embed-spa` feature). |
| `error.rs` | Canonical `ApiError` enum + its `Responder` (HTTP status + JSON body). |

### Style

- Errors: return `ApiError` (the enum in `error.rs`) — its variants map to the canonical status + JSON. Use `ApiError::Internal("<context>")` for ad-hoc internal errors.
- Authorization is **per-prefix**, enforced inside each handler (the `authorize*` helpers in `routes.rs`). Keep the allow-list in sync with `docs/specs/mvp-v0.1.md` "Storage API".
- Routing is Rocket attribute routes (`#[get("/v1/...")]`) collected in `build()`. Authentication is a request **guard** (`AuthedUser`), not middleware — a handler that needs a token takes the guard as `Result<AuthedUser, ApiError>` and `?`-propagates.
- Logs follow ADR-0010 (logfmt `key=value`, never JSON) via a custom `log::Log` sink + a request-log fairing in `logging.rs` (emits `msg=request …` with a `request_id`, echoed as `X-Request-Id`); at the default level only this crate's records are emitted, Rocket's per-request chatter is filtered. Never `println!` on the request path.

### Testing

- Handler tests use `MemStore` + Rocket's `LocalClient` — never real S3. Helpers live in the `#[cfg(test)]` module at the foot of `routes.rs` (`client_with`, `seed_account`, `bearer`, …); reuse them.
- Cover the golden path **and** authorization rejections for every endpoint. Other-user-prefix denials are not optional.
- Keep `MemStore` and `S3Store` in lockstep — when the `Store` trait changes, both implement the new method.
- Cross-language interop vectors (token, auth-proof, CBOR) live in `tests/` + `tests/vectors/` — the frozen contract with the TS client (ADR-0019). Don't regenerate them casually.

### Adding an endpoint — checklist

1. Update the active milestone spec under `docs/specs/` (request/response shape, error codes, S3 effects).
2. Add an ADR if the change crosses a trust boundary, introduces a dependency, or affects storage layout (see `docs/decisions/README.md`).
3. Add the handler in `routes.rs` and register it in the `routes![]` list in `build()`; take `AuthedUser` if it needs a token.
4. Add a typed wrapper in `web/src/lib/api.ts` and a request type alongside.
5. Tests: a handler-level Rust test (golden + 400 + 401/403) using `MemStore`; a unit test for the `api.ts` wrapper.
6. If it changes a user-visible flow, update or add a `docs/scenarios/*.md` and a matching `web/e2e/*.spec.ts`.

## S3 layout (canonical — do not drift)

| Prefix | Owner | Notes |
|---|---|---|
| `users/{uid}/profile.json` | server (registration / `PUT /v1/profile`) | Source of truth for profile data |
| `users/{uid}/devices/{did}.json` | server | Existence = device is valid; deletion = revoked |
| `users/{uid}/rotation-records/{request_id}.json` | server (`POST /v1/rotate-keys`) | Idempotency record; 24h TTL |
| `users/{uid}/contacts.json` | client (presigned PUT, AES-256-GCM with backup key) | E2E encrypted |
| `users/{uid}/read-markers.json` | client (presigned PUT, AES-256-GCM with backup key) | E2E encrypted; `conversation_id → last-read timestamp`, merged per-key `max()` (ADR-0026) |
| `handles/{handle}.json` | server (projection of `profile.json` public fields) | Resolve cache |
| `inbox/{uid}/live/{msg_id}` | server (`POST /v1/send`) | JSON envelope |
| `inbox/{uid}/archive/{date}-{ULID}` | server (`POST /v1/store/compact`) | CBOR array |
| `keys/{uid}/live/{base64url(session_id)}` | client (presigned PUT) | Encrypted Megolm session key (envelope `{v, iv, ciphertext, session_id, msg_id}`). Key segment is base64url (object-name-safe); body carries the raw `session_id`. |
| `keys/{uid}/archive/{date}-{ULID}` | server (compaction) | CBOR array (entries may mix `v`) |
| `keys/{uid}/key_chain.json` | client (presigned PUT, rotation only) | Old backup keys wrapped by their successors; absent until first rotation |
| `media/{uid}/{ulid}` | client (presigned PUT) | AES-256-GCM ciphertext |

Full schema and lifecycle: `docs/specs/mvp-v0.1.md`.

## Documentation rules

- **Specs** describe *what* and *how* the system behaves. Update the spec in the same PR as the implementation. If a spec section becomes wrong, fix the spec — never leave it as historical record.
- **ADRs** describe *why* — they are append-only and immutable. Create a new ADR (next sequential number) to supersede an old one; do not edit accepted ADRs except to mark them superseded with a link.
- **Scenarios** double as e2e specs. New user-facing flow → new scenario file → matching `web/e2e/*.spec.ts`.
- **Invariants** describe what must hold under adverse conditions (faults, retries, concurrency). One file per invariant under `docs/scenarios/invariants/`, indexed by [`invariants/README.md`](docs/scenarios/invariants/README.md). New invariant → row in the README prioritisation table → a new `i{N}-<name>.md` using the Statement / Fault construction / Assertions / Permitted divergence template → `web/e2e/invariants/<name>.spec.ts`. See the "Adding a new invariant" checklist in the index.
- **Evolution notes** are deliberately speculative; nothing in `docs/evolution/` is a commitment. Don't reference an evolution note as if it were a spec.
- **Tasks** in `tasks/` are intent-to-implement docs — the *frontier*. They get deleted once landed. Use the `Spec → Current → Change → Verify` template the existing files use. Keep `tasks/README.md` a forward-looking one-line-per-item list (active/upcoming/parked); **never let it accrete "T1 landed…" changelog prose** — that belongs in the diary.
- **Releases** in `docs/releases/` are the *diary*: a past-tense record of what shipped per milestone (`v0.N.md`, patches as subsections), with highlights and bundle/cost deltas. Append-only after a tag; a file may exist before its tag is cut. This is where landed-work narrative lives — not in specs (current-state) or tasks (frontier). The automated changelog/cut process is still open in [ADR-0017](docs/decisions/adr-0017-versioning-and-releases.md).

Reference style:
- Mermaid diagrams for sequence flows in scenarios.
- Backticks for paths, env vars, and code identifiers.
- ULID-shaped placeholders (`01HWQA…`) — never real values from production.

## Operations

`docs/ops.md` is the canonical infrastructure doc — Scaleway resources, env vars, CORS config, deploy commands, log query recipes (Cockpit / Grafana per ADR-0010). Update it whenever you add an env var, change the deploy pipeline, or modify required infrastructure.

`make build` compiles the server with the SPA wired in via rust-embed (the `embed-spa` cargo feature); `server-build` builds `web/dist` first so it's in place. Release builds (the Docker image) embed the assets into the binary; debug builds read `web/dist` from disk. The Dockerfile builds web then the release server across stages.

## Pre-commit

`make install` copies `scripts/pre-commit` to `.git/hooks/`. It runs `make fmt lint test` and blocks bad commits. Don't bypass with `--no-verify` unless you understand exactly which gate is failing — fix the underlying issue.
