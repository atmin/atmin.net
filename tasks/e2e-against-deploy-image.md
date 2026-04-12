# Run e2e tests against the actual deploy image

## Motivation
Currently e2e tests run `go run .` against source with Vite in dev mode (see `web/playwright.config.ts`). The Docker image produced by `Dockerfile` is never exercised before deploy. First deploy to Scaleway was where an amd64/arm64 mismatch was caught — a bug e2e could have caught if it ran against the image. Goal: whatever gets deployed to prod is byte-identical to what e2e validated.

## Current CI flow (`.github/workflows/deploy.yml`)
Four jobs: `lint`, `test`, `e2e`, `deploy`. `e2e` runs only on `v*` tags. `deploy` needs `[lint, test, e2e]` and builds + pushes the image itself. `lint` and `test` run on every push to master.

`e2e` job steps: checkout → setup Node/Go/Rust → `make web-build` → copy `web/dist` → `server/dist` → install Playwright → `npx playwright test`. Playwright config (`web/playwright.config.ts`) starts two `webServer` processes: Vite (port 5174) and `go run .` (port 8081), with MinIO on port 9000 started manually in the workflow.

## Target flow

1. **`build` job** — builds the Docker image once with `APP_VERSION=${{ github.ref_name }}` as build arg. `docker save` the image to a tar, upload as a GHA artifact named `app-image`. Runs on every push (master + tags). No registry push here.

2. **`lint` + `test` jobs** — unchanged, continue running against source in parallel with `build`. These validate code, not runtime.

3. **`e2e` job** (tag-only, `needs: build`) — downloads the `app-image` artifact, `docker load`s it, runs it on port 8080 with MinIO sidecar, points Playwright at `http://localhost:8080`. No Vite, no `go run`.

4. **`deploy` job** (tag-only, `needs: [lint, test, e2e]`) — downloads the same artifact, `docker load`s, tags as `${{ github.ref_name }}` and `latest`, pushes to Scaleway Container Registry, then `scw container container deploy`. **No rebuild.**

GHA artifacts auto-expire (default 90 days), so no registry pollution from candidates — only the final deployed images ever touch Scaleway.

## Changes required

### `.github/workflows/deploy.yml`
- Add a `build` job: `docker/build-push-action@v6` with `push: false`, `outputs: type=docker,dest=/tmp/app-image.tar`, keep `cache-from/cache-to: type=gha`. Pass `APP_VERSION=${{ github.ref_name }}`. Upload `/tmp/app-image.tar` via `actions/upload-artifact@v4` with name `app-image`.
- Rewrite `e2e` job: drop Node/Go/Rust setup and `make web-build`. Download `app-image` artifact, `docker load -i app-image.tar`. Run container: `docker run -d -p 8080:8080 --network host -e SERVER_SECRET=... -e S3_ENDPOINT=http://localhost:9000 ...`. Keep MinIO. Install Playwright (still need web dir for test files and chromium). Run `npx playwright test`.
- Rewrite `deploy` job: no `docker build`. Download `app-image` artifact, `docker load`, `docker tag`, `docker login`, `docker push` with the `v*` and `latest` tags. Keep the `scw container container deploy` step.

### `web/playwright.config.ts`
- Remove both entries from `webServer: []` array (the Vite and Go processes). Playwright will just use the already-running container.
- Change `baseURL` to `http://localhost:8080` (the container serves both the SPA and API).
- The `E2E_BUCKET` env var generation (line 5) still works — it's passed to the container at `docker run` time via the workflow.

### `web/e2e-global-setup.ts` and `web/e2e-global-teardown.ts`
- Verify they don't assume the Go server or Vite are managed by Playwright. Bucket creation/cleanup via MinIO should still work.

## Verify
- Push a commit to master: CI runs `build` + `lint` + `test`, no `e2e`, no `deploy`. Image exists only as a GHA artifact.
- Push a `v*` tag: CI runs `build` + `lint` + `test` + `e2e` (against the loaded image) + `deploy` (which loads, tags, pushes, deploys the same image).
- Verify the deployed container's `/` shows the expected version in the landing page footer (proves `APP_VERSION` arg propagated).
- Verify e2e logs show `docker load` / `docker run` instead of `go run` / Vite.
- Verify the Scaleway registry only contains `v*` and `latest` tags — no `sha-*` or per-commit cruft.

## Non-goals
- Running lint/test *inside* the image — they validate source, not runtime. Skip.
- Caching the ephemeral image across PRs — GHA's Docker layer cache (`type=gha`) already handles this.
