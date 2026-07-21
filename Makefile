DOCKER ?= docker

# Host ports the local MinIO (docker-compose) publishes. Deliberately
# non-standard so a parallel MinIO on the default 9000/9001 doesn't clash;
# override per-run, e.g. `MINIO_PORT=31000 make e2e-local`. The container-
# internal ports stay 9000/9001 (see docker-compose.yml). CI (deploy.yml) runs
# its own standalone MinIO on 9000 and is unaffected by these.
MINIO_PORT ?= 29000
MINIO_CONSOLE_PORT ?= 29001
export MINIO_PORT MINIO_CONSOLE_PORT

.PHONY: all build test lint fmt clean dev run e2e e2e-local install
.PHONY: server-test server-lint server-fmt server-build
.PHONY: web-dev web-wasm web-build web-test web-lint web-lint-arch web-fmt web-storybook
.PHONY: site-dev site-build site-check
.PHONY: icons
.PHONY: up down

# --- Setup ---

install:
	@missing=""; \
	command -v pnpm      >/dev/null 2>&1 || missing="$$missing\n  pnpm      — Node package manager  — https://pnpm.io/installation"; \
	command -v cargo     >/dev/null 2>&1 || missing="$$missing\n  cargo     — Rust toolchain        — https://rustup.rs/"; \
	command -v wasm-pack >/dev/null 2>&1 || missing="$$missing\n  wasm-pack — Rust→WASM build       — https://rustwasm.github.io/wasm-pack/installer/  (or: cargo install wasm-pack)"; \
	command -v $(DOCKER) >/dev/null 2>&1 || missing="$$missing\n  $(DOCKER)    — containers (MinIO, e2e) — https://docs.docker.com/get-docker/"; \
	if [ -n "$$missing" ]; then \
		printf "ERROR: missing required tools:$$missing\n\nInstall the listed tools and re-run 'make install'.\n"; \
		exit 1; \
	fi
	@if command -v rustup >/dev/null 2>&1; then \
		rustup target list --installed 2>/dev/null | grep -q '^wasm32-unknown-unknown$$' || \
			(echo "ERROR: rust target 'wasm32-unknown-unknown' not installed — run: rustup target add wasm32-unknown-unknown" && exit 1); \
	else \
		echo "WARNING: rustup not detected — ensure the 'wasm32-unknown-unknown' target is available for your Rust install"; \
	fi
	cd web && pnpm install
	cd site && pnpm install
	@test -f .env || cp .env.example .env
	cp scripts/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
	@echo "Done. Run 'make dev' to start."

# --- Aggregates ---

all: lint test build

build: server-build

test: web-test server-test

lint: web-lint web-lint-arch server-lint

fmt: web-fmt server-fmt

# --- Server (Rust) ---

server-test:
	cd server && cargo test

# fmt --check lives in lint so the pre-commit hook (lint + test) catches unformatted
# Rust; clippy -D warnings treats every lint as an error. --lib --bins --tests covers
# source, the dev binary, and tests but skips the throwaway examples/ playground.
server-lint:
	cd server && cargo fmt --check && cargo clippy --lib --bins --tests -- -D warnings

server-fmt:
	cd server && cargo fmt

# Build the server with the embedded SPA. Depends on web-build so dist is always
# fresh — a stale dist served via rust-embed's debug mode is a footgun. Debug build:
# rust-embed reads ../web/dist live; the Docker image does the release embed for deploys.
server-build: web-build
	cd server && cargo build --features embed-spa

# --- Web (TypeScript) ---

web-dev:
	cd web && pnpm dev

web-wasm:
	cd web && pnpm build:wasm

web-build: web-wasm
	cd web && pnpm build

web-test: web-wasm
	cd web && pnpm test

web-lint: web-wasm
	cd web && pnpm lint

web-lint-arch:
	web/scripts/lint-architecture.sh

web-storybook:
	cd web && pnpm storybook

web-fmt:
	cd web && pnpm lint:fix

# --- Site (marketing, ADR-0025) ---
# Independent of the app: its own deploy (.github/workflows/site.yml → Scaleway
# static bucket), so it's deliberately NOT wired into all/build/lint/test.
# `site-build` runs `astro check` first, so type errors fail the build like
# web's `tsc && vite build`.

site-dev:
	cd site && pnpm dev

site-build:
	cd site && pnpm build

site-check:
	cd site && pnpm check

# --- Branding ---

FAVICON := web/public/favicon.svg
# Flatten onto white (matches the manifest background_color) and pad the 100×100
# page by 13 units each side so the full-bleed mark clears the maskable crop.
ICON_EXPORT := --export-area=-13:-13:113:113 --export-background=white --export-background-opacity=1

# Regenerate the PWA raster icons from favicon.svg — the single source of truth
# for the logo (web/src/components/Logo.tsx shares the same path). Re-run after
# editing favicon.svg.
icons:
	@command -v inkscape >/dev/null 2>&1 || { echo "ERROR: inkscape not found — install https://inkscape.org/ and re-run 'make icons'."; exit 1; }
	inkscape $(FAVICON) -o web/public/icons/icon-512.png        -w 512 -h 512 $(ICON_EXPORT)
	inkscape $(FAVICON) -o web/public/icons/icon-192.png        -w 192 -h 192 $(ICON_EXPORT)
	inkscape $(FAVICON) -o web/public/icons/apple-touch-icon.png -w 180 -h 180 $(ICON_EXPORT)
	@echo "Regenerated PWA icons from $(FAVICON). If the artwork changed, sync the <path> in web/src/components/Logo.tsx too."

# --- Dev (all-in-one) ---

dev:
	$(DOCKER) compose up -d
	@set -a; . ./.env; set +a; \
	printf 'waiting for MinIO bucket %s …\n' "$$S3_BUCKET"; \
	for i in $$(seq 1 50); do \
		code=$$(curl -s -o /dev/null -w '%{http_code}' "$$S3_ENDPOINT/$$S3_BUCKET" 2>/dev/null || echo 000); \
		case $$code in 200|403) break;; esac; \
		sleep 0.2; \
	done; \
	trap 'kill 0' EXIT; \
	(cd server && ROCKET_PORT=8080 cargo run) & \
	(cd web && pnpm dev) & \
	wait

run:
	set -a; . ./.env; set +a; ROCKET_PORT=8080 ./server/target/debug/atmin-server

# --- Docker (local dev) ---

up:
	$(DOCKER) compose up -d

down:
	$(DOCKER) compose down

e2e: web-build
	$(DOCKER) compose up -d
	$(DOCKER) build --build-arg APP_VERSION=dev -t atmindotnet:e2e .
	$(DOCKER) rm -f atmin-e2e 2>/dev/null || true
	$(DOCKER) run -d --name atmin-e2e \
		-p 8080:8080 \
		--add-host=host.docker.internal:host-gateway \
		--add-host=host.containers.internal:host-gateway \
		-e SERVER_SECRET=e2e-test-secret \
		-e DANGEROUSLY_DISABLE_REGISTRATION_POW=yes-i-am-the-e2e-suite \
		-e S3_ENDPOINT=http://host.containers.internal:$(MINIO_PORT) \
		-e S3_PUBLIC_ENDPOINT=http://localhost:$(MINIO_PORT) \
		-e S3_BUCKET=atmin-e2e-local \
		-e S3_REGION=us-east-1 \
		-e S3_ACCESS_KEY=minioadmin \
		-e S3_SECRET_KEY=minioadmin \
		atmindotnet:e2e
	cd web && E2E_BUCKET=atmin-e2e-local E2E_S3_ENDPOINT=http://localhost:$(MINIO_PORT) pnpm exec playwright test; \
		status=$$?; $(DOCKER) rm -f atmin-e2e; exit $$status

# Fast local e2e: runs the embed-spa server binary natively (no docker build) on
# :8080. Needs `docker compose up -d` for MinIO; wipes its volume for a clean slate.
#
# Pass SPEC=... to scope the run:
#   make e2e-local SPEC=media                     # one file (substring match)
#   make e2e-local SPEC=e2e/media.spec.ts         # path form
#   make e2e-local SPEC="media -g 'inline image'" # filter by test title
e2e-local: server-build
	@$(DOCKER) rm -f atmin-e2e 2>/dev/null || true
	@# Free :8080 from a stray server left by an interrupted run.
	@pkill -f 'target/debug/atmin-server' 2>/dev/null || true
	$(DOCKER) compose down -v 2>/dev/null || true
	$(DOCKER) compose up -d
	@BUCKET=atmin-e2e-local-$$$$; \
	export SERVER_SECRET=e2e-test-secret; \
	export DANGEROUSLY_DISABLE_REGISTRATION_POW=yes-i-am-the-e2e-suite; \
	export S3_ENDPOINT=http://localhost:$(MINIO_PORT); \
	export S3_PUBLIC_ENDPOINT=http://localhost:$(MINIO_PORT); \
	export S3_BUCKET=$$BUCKET; \
	export S3_REGION=us-east-1; \
	export S3_ACCESS_KEY=minioadmin; \
	export S3_SECRET_KEY=minioadmin; \
	export ROCKET_PORT=8080; \
	./server/target/debug/atmin-server & \
	SERVER_PID=$$!; \
	trap "kill $$SERVER_PID 2>/dev/null || true" EXIT INT TERM; \
	up=""; \
	for i in $$(seq 1 50); do \
		if curl -sf http://localhost:8080/healthz >/dev/null; then up=1; break; fi; \
		sleep 0.2; \
	done; \
	if [ -z "$$up" ]; then echo "server did not come up on :8080" >&2; kill $$SERVER_PID 2>/dev/null || true; exit 1; fi; \
	cd web && E2E_BUCKET=$$BUCKET E2E_S3_ENDPOINT=http://localhost:$(MINIO_PORT) pnpm exec playwright test $(SPEC); \
	status=$$?; \
	kill $$SERVER_PID 2>/dev/null || true; \
	exit $$status

clean:
	cd server && cargo clean
