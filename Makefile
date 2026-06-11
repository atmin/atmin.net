DOCKER ?= docker

.PHONY: all build test lint fmt clean dev run e2e e2e-local e2e-local-rs install
.PHONY: server server-build server-test server-lint server-fmt
.PHONY: server-rs-test server-rs-lint server-rs-fmt server-rs-build
.PHONY: web-dev web-wasm web-build web-test web-lint web-lint-arch web-fmt web-storybook
.PHONY: up down

# --- Setup ---

install:
	@missing=""; \
	command -v go        >/dev/null 2>&1 || missing="$$missing\n  go        — Go toolchain         — https://golang.org/dl/"; \
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
	@test -f .env || cp .env.example .env
	cp scripts/pre-commit .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
	@echo "Done. Run 'make dev' to start."

# --- Aggregates ---

all: lint test build

build: web-build server-build

test: server-test web-test server-rs-test

lint: server-lint web-lint web-lint-arch server-rs-lint

fmt: server-fmt web-fmt server-rs-fmt

# --- Server (Go) ---

server:
	set -a; . ./.env; set +a; cd server && go run .

server-build: web-build
	rm -rf server/dist
	cp -r web/dist server/dist
	cd server && go build -o ../bin/atmin .

# Placeholder so //go:embed dist resolves for lint/test without a full web build.
# Filename has no leading dot so the embed directive does not skip it.
# server-build wipes this directory before copying the real web bundle in.
server/dist/PLACEHOLDER:
	@mkdir -p server/dist
	@echo "placeholder for //go:embed dist; replaced by server-build" > server/dist/PLACEHOLDER

server-test: server/dist/PLACEHOLDER
	cd server && go test ./...

server-lint: server/dist/PLACEHOLDER
	cd server && go vet ./...

server-fmt:
	cd server && gofmt -w .

# --- Server (Rust, experimental — ADR-0018; not in `build`, Go is still the deployed binary) ---

server-rs-test:
	cd server-rs && cargo test

# fmt --check lives in lint so the pre-commit hook (lint + test) catches unformatted
# Rust; clippy -D warnings treats every lint as an error. --lib --bins --tests covers
# source, the dev binary, and tests but skips the throwaway examples/ playground.
server-rs-lint:
	cd server-rs && cargo fmt --check && cargo clippy --lib --bins --tests -- -D warnings

server-rs-fmt:
	cd server-rs && cargo fmt

# Build the Rust server with the embedded SPA (ADR-0018 phase 6). Depends on
# web-build so dist is always fresh — a stale dist served via rust-embed's debug
# mode is the footgun the phase-6 validation hit. Debug build: rust-embed reads
# ../web/dist live, so the just-built SPA is served without a release embed.
server-rs-build: web-build
	cd server-rs && cargo build --features embed-spa

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

# --- Dev (all-in-one) ---

dev:
	$(DOCKER) compose up -d
	@set -a; . ./.env; set +a; \
	trap 'kill 0' EXIT; \
	(cd server && go run .) & \
	(cd web && pnpm dev) & \
	wait

run:
	set -a; . ./.env; set +a; ./bin/atmin

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
		-e S3_ENDPOINT=http://host.containers.internal:9000 \
		-e S3_PUBLIC_ENDPOINT=http://localhost:9000 \
		-e S3_BUCKET=atmin-e2e-local \
		-e S3_REGION=us-east-1 \
		-e S3_ACCESS_KEY=minioadmin \
		-e S3_SECRET_KEY=minioadmin \
		atmindotnet:e2e
	cd web && E2E_BUCKET=atmin-e2e-local pnpm exec playwright test; \
		status=$$?; $(DOCKER) rm -f atmin-e2e; exit $$status

# Fast local e2e: runs the server natively (no docker build).
# Still needs `docker compose up -d` for MinIO.
#
# Pass SPEC=... to scope the run:
#   make e2e-local SPEC=media                     # one file (substring match)
#   make e2e-local SPEC=e2e/media.spec.ts         # path form
#   make e2e-local SPEC="media -g 'inline image'" # filter by test title
e2e-local: web-build server-build
	@$(DOCKER) rm -f atmin-e2e 2>/dev/null || true
	@# Clean slate to deflake: kill any stray server from an interrupted run
	@# (frees :8080) and wipe MinIO's volume so no accumulated state or a
	@# recycled bucket name leaks across runs. The server's in-process caches
	@# also start empty since it's (re)started below.
	@pkill -f 'bin/atmin' 2>/dev/null || true
	$(DOCKER) compose down -v 2>/dev/null || true
	$(DOCKER) compose up -d
	@BUCKET=atmin-e2e-local-$$$$; \
	export SERVER_SECRET=e2e-test-secret; \
	export S3_ENDPOINT=http://localhost:9000; \
	export S3_PUBLIC_ENDPOINT=http://localhost:9000; \
	export S3_BUCKET=$$BUCKET; \
	export S3_REGION=us-east-1; \
	export S3_ACCESS_KEY=minioadmin; \
	export S3_SECRET_KEY=minioadmin; \
	./bin/atmin & \
	SERVER_PID=$$!; \
	trap "kill $$SERVER_PID 2>/dev/null || true" EXIT INT TERM; \
	up=""; \
	for i in $$(seq 1 50); do \
		if curl -sf http://localhost:8080/healthz >/dev/null; then up=1; break; fi; \
		sleep 0.2; \
	done; \
	if [ -z "$$up" ]; then echo "server did not come up on :8080" >&2; kill $$SERVER_PID 2>/dev/null || true; exit 1; fi; \
	cd web && E2E_BUCKET=$$BUCKET pnpm exec playwright test $(SPEC); \
	status=$$?; \
	kill $$SERVER_PID 2>/dev/null || true; \
	exit $$status

# Same fast-local e2e, but against the RUST server (ADR-0018 phase 6): the
# embed-spa binary on :8080 in place of the Go binary. The unmodified Playwright
# suite is the spike's exit criterion. Still needs Docker for MinIO; wipes its
# volume for a clean slate. SPEC scopes the run exactly as e2e-local.
#
#   make e2e-local-rs
#   make e2e-local-rs SPEC=media
e2e-local-rs: server-rs-build
	@$(DOCKER) rm -f atmin-e2e 2>/dev/null || true
	@# Free :8080 from a stray Go or Rust server left by an interrupted run.
	@pkill -f 'bin/atmin' 2>/dev/null || true
	@pkill -f 'target/debug/atmin-server' 2>/dev/null || true
	$(DOCKER) compose down -v 2>/dev/null || true
	$(DOCKER) compose up -d
	@BUCKET=atmin-e2e-rs-$$$$; \
	export SERVER_SECRET=e2e-test-secret; \
	export S3_ENDPOINT=http://localhost:9000; \
	export S3_PUBLIC_ENDPOINT=http://localhost:9000; \
	export S3_BUCKET=$$BUCKET; \
	export S3_REGION=us-east-1; \
	export S3_ACCESS_KEY=minioadmin; \
	export S3_SECRET_KEY=minioadmin; \
	export ROCKET_PORT=8080; \
	./server-rs/target/debug/atmin-server & \
	SERVER_PID=$$!; \
	trap "kill $$SERVER_PID 2>/dev/null || true" EXIT INT TERM; \
	up=""; \
	for i in $$(seq 1 50); do \
		if curl -sf http://localhost:8080/healthz >/dev/null; then up=1; break; fi; \
		sleep 0.2; \
	done; \
	if [ -z "$$up" ]; then echo "rust server did not come up on :8080" >&2; kill $$SERVER_PID 2>/dev/null || true; exit 1; fi; \
	cd web && E2E_BUCKET=$$BUCKET pnpm exec playwright test $(SPEC); \
	status=$$?; \
	kill $$SERVER_PID 2>/dev/null || true; \
	exit $$status

clean:
	rm -rf bin/
