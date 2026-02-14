.PHONY: all build test lint fmt clean dev run
.PHONY: server server-build server-test server-lint server-fmt
.PHONY: web-dev web-wasm web-build web-test web-lint web-fmt
.PHONY: up down

# --- Aggregates ---

all: lint test build

build: web-build server-build

test: server-test web-test

lint: server-lint web-lint

fmt: server-fmt web-fmt

# --- Server (Go) ---

server:
	set -a; . ./.env; set +a; cd server && go run .

server-build:
	rm -rf server/dist
	cp -r web/dist server/dist
	cd server && go build -o ../bin/atmin .

server-test:
	cd server && go test ./...

server-lint:
	cd server && go vet ./...

server-fmt:
	cd server && gofmt -w .

# --- Web (TypeScript) ---

web-dev:
	cd web && npm run dev

web-wasm:
	cd web && npm run build:wasm

web-build: web-wasm
	cd web && npm run build

web-test:
	cd web && npm test

web-lint:
	cd web && npm run lint

web-fmt:
	cd web && npm run lint:fix

# --- Dev (all-in-one) ---

dev:
	docker compose up -d
	@set -a; . ./.env; set +a; \
	trap 'kill 0' EXIT; \
	(cd server && go run .) & \
	(cd web && npm run dev) & \
	wait

run:
	set -a; . ./.env; set +a; ./bin/atmin

# --- Docker (local dev) ---

up:
	docker compose up -d

down:
	docker compose down

clean:
	rm -rf bin/
