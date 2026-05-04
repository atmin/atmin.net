# Stage 1: Build web assets (Node + Rust/wasm-pack)
FROM node:25-alpine AS web

RUN wget -qO- https://github.com/pnpm/pnpm/releases/download/v11.0.4/pnpm-linux-x64-musl.tar.gz | tar -xz -C /usr/local/bin
RUN apk add --no-cache curl bash build-base
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --target wasm32-unknown-unknown
ENV PATH="/root/.cargo/bin:${PATH}"
RUN cargo install wasm-pack wasm-bindgen-cli@0.2.108

WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY web/crypto ./crypto
RUN pnpm build:wasm

COPY web/ .

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
RUN pnpm build

# Stage 2: Build Go binary
FROM golang:1.26-alpine AS server

WORKDIR /app/server
COPY server/go.mod server/go.sum ./
RUN go mod download

COPY server/ .
COPY --from=web /app/web/dist ./dist
RUN CGO_ENABLED=0 go build -o /atmin .

# Stage 3: Minimal runtime
FROM alpine:3.21

RUN apk add --no-cache ca-certificates
COPY --from=server /atmin /atmin

EXPOSE 8080
ENTRYPOINT ["/atmin"]
