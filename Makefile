.PHONY: all build test lint fmt clean
.PHONY: server server-build server-test server-lint server-fmt
.PHONY: web-wasm web-build web-test web-lint web-fmt
.PHONY: up down

# --- Aggregates ---

all: lint test build

build: server-build web-wasm

test: server-test web-test

lint: server-lint web-lint

fmt: server-fmt web-fmt

# --- Server (Go) ---

server:
	cd server && go run .

server-build:
	cd server && go build -o ../bin/server .

server-test:
	cd server && go test ./...

server-lint:
	cd server && go vet ./...

server-fmt:
	cd server && gofmt -w .

# --- Web (TypeScript) ---

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

# --- Docker (local dev) ---

up:
	docker compose up -d

down:
	docker compose down

clean:
	rm -rf bin/
