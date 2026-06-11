# Rust cutover — retire Go, adopt the Rust backend (ADR-0018 → ADR-0019)

The Rust port met its exit criterion (full e2e green 5×) and passed real-infra
interop on staging (live Go-authenticated devices survived the swap invisibly;
Go-written history/archives/key_chain read fine). This task is the cutover: make
Rust the deployed backend, retire Go, groom the docs, and merge — **fast-forward,
preserving the increment-by-increment history**.

Delete this file once the cutover lands.

## Sequencing principles (read first)

- **The deploy is live on `rust-port-experiment` right now** — every push redeploys
  staging. That's a feature: each cleanup commit is re-validated on staging. It stays
  true until step 6 flips the trigger.
- **Keep every commit green + deployable.** The delete/rename touches the
  Dockerfile/Makefile that build the staging image; update them in the same commit so
  staging never goes red.
- **The trigger flip (6) and the merge (7) are last**, in that order.
- **Don't de-Go the ADRs** — they're immutable history. Only *code comments* and
  *active docs* (CONTRIBUTING, ops.md, README, specs) get cleansed.

## 0. Pre-flight (checks, not commits)

- [ ] **Fast-forward is actually possible:** `git log --oneline rust-port-experiment..master`
      is empty (master hasn't advanced since the branch point). If not → `git rebase master`
      on the branch first, *then* ff. FF preserves all commits only if master is an ancestor.
- [ ] **Branch protection on master** won't block a direct ff push (or decide: relax it
      temporarily, vs GitHub "Rebase and merge" which preserves commits but rewrites hashes).
- [ ] **`server-rs/Cargo.lock` is committed** (reproducible Docker release builds).
- [ ] (Optional) let staging bake / poke it a bit more before starting.

## 1. Decision records (docs, zero build risk)

- [ ] Write **ADR-0019 "Adopt the Rust backend, retire Go"** (next free number — verify):
      the transition decision — evidence (5× e2e, local + staging interop), consequences
      (single TS+Rust codebase, the dep-tree/CI cost, the abuse-resistance plan unparks),
      references ADR-0018. Note: the interop golden vectors become *frozen* conformance
      guards — the `GEN_VECTORS` Go emitter is deleted, so they can't be regenerated from
      Go, only validated against (+ the surviving TS emitter).
- [ ] **Finalize ADR-0018**: status Draft → Accepted; outcome (exit criterion met); link
      to ADR-0019. *Last edit before it freezes.*

## 2. Retire Go + make Rust canonical (keep build green)

- [ ] Delete the Go `server/`. Repoint the **Makefile** so Rust *is* the server:
      `make build` → Rust `cargo build --release --features embed-spa` (depends on
      `web-build`); fold `e2e-local-rs` → `e2e-local`; `server-rs-{fmt,lint,test,build}` →
      `server-*`; drop the "cargo steps not in `make build`" note; drop `make install`'s
      Go toolchain check.
- [ ] `.gitignore`: drop `server/dist` (Go embed); keep the Rust `target/`.
- [ ] **Rename `server-rs/` → `server/`** (`git mv`).
- [ ] **Grep the whole repo for `server-rs`** and fix every reference: Dockerfile,
      `.github/workflows/deploy.yml`, `scripts/flaky-compare.sh`, CONTRIBUTING.md, ops.md,
      `tasks/*.md` links, `.gitignore`. Confirm zero stragglers.

## 3. Groom the code comments

- [ ] Strip the porting-diary phrasing across the renamed `server/` — "mirrors Go's X",
      "mirrors `server/X.go`", "deferred to phase N", "the phase-1 finding". Every comment
      describes the code *as it is*, with no reference to Go, the port, or the phase it
      landed in. Reads as if it were always Rust.

## 4. CI cleanup (`.github/workflows/deploy.yml`)

- [ ] Remove `setup-go`, the **"Stub web dist for go embed"** steps, the Go module cache.
- [ ] **Add `Swatinem/rust-cache@v2`** to the `lint` + `test` jobs (the deferred item — the
      ~400-crate aws-sdk tree cold-compiles every run without it).
- [ ] Tidy the `e2e` job's `docker run` env (drop Go-only `LISTEN_ADDR`; the image bakes
      `ROCKET_ADDRESS`/`ROCKET_PORT`).

## 5. Active (non-ADR) docs

- [ ] **CONTRIBUTING.md** — rewrite the "Backend (`server/`)" section for Rust: file map,
      Rocket, error/`ApiError` style, the gates (`make fmt lint test` = cargo fmt/clippy/test),
      the `embed-spa` feature, the project layout block.
- [ ] **docs/ops.md** — "stateless **Go** container" → Rust; `LISTEN_ADDR` → `ROCKET_ADDRESS`/
      `ROCKET_PORT`; runtime env-vars table; any deploy/log recipes that assume Go.
- [ ] **README** — badges (CI, language Go→Rust), prose/architecture mentions.
- [ ] Grep `docs/specs` + `docs/scenarios` for stray "Go" (mostly impl-agnostic — fix any
      that name the implementation).

## 6. Flip the deploy trigger back to master — **the last branch commit**

- [ ] `deploy.yml`: the two `# TEMP` spots `rust-port-experiment` → `master` (push trigger +
      `deploy-staging` gate). ⚠️ After this commit, branch pushes no longer deploy staging —
      so it must be the final commit before the merge.

## 7. Merge (fast-forward)

- [ ] (Rebase onto master if step 0 flagged divergence.) `git merge --ff-only
      rust-port-experiment` into master (or push the branch as master) — linear history, all
      increments preserved. Master push → staging redeploys the Rust image via the master
      trigger. Confirm staging stays green.

## 8. Prod cutover

- [ ] **Cut a `v*` tag** → drives the prod path (e2e → deploy prod → repoint cleanup job to
      the Rust image). ⚠️ The merge alone only touches staging; the tag is the prod trigger.
      Don't tag until staging is fully vetted.
- [ ] **Wire the Scaleway cleanup Serverless Job** against the Rust image (the cutover
      prerequisite — `SCW_CLEANUP_JOB_DEFINITION_ID` is currently inert; create the job +
      secret, see docs/ops.md). Verify a dry-run; without it the ADR-0006/0013 retention
      sweeps silently never run. `/atmin cleanup [--apply]` arg-dispatch already works.

## 9. Post-cutover follow-ups

- [ ] **First thing:** the 🔴 [key-backup `session_id` S3-key bug](key-backup-unsafe-session-id-key.md)
      — fix on master; `flaky-compare.sh UNTIL_FAIL SPEC=credential-rotate-ui` should flip
      ~4% → 0 as the regression guard.
- [ ] **Then:** [structured (logfmt) logging](rust-structured-logging.md) per ADR-0010 —
      conform the Rust logs to slog-style `key=value` (not JSON) + restore the request log.
      Not cutover-gating (no log aggregator consumes them yet); sequenced after the bugfix.
- [ ] Delete landed task files ([rust-backend-spike.md](rust-backend-spike.md), this file) +
      tidy [tasks/README](README.md).
- [ ] The parked **abuse-resistance plan** (Argon2 PoW registration, reconsider Turnstile,
      rocket-governor) — its "after the Rust port" gate is now met; amend Draft ADR-0007 then.
