# Stage 1: Build web assets (Node + Rust/wasm-pack)
FROM node:25-alpine AS web

RUN npm install -g pnpm@11.0.4
RUN apk add --no-cache curl bash build-base
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain stable --target wasm32-unknown-unknown
ENV PATH="/root/.cargo/bin:${PATH}"
RUN cargo install wasm-pack wasm-bindgen-cli@0.2.108

WORKDIR /app/web
COPY web/package.json web/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-scripts && pnpm rebuild esbuild msw

COPY web/crypto ./crypto
RUN pnpm build:wasm

COPY web/ .

ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
RUN pnpm build

# Stage 2: Build the Rust server (release, with the SPA embedded via `embed-spa`).
# aws-sdk-s3 pulls aws-lc-rs, which needs cmake + a C toolchain (the toolchain is
# already in the buildpack-deps-based rust image; cmake is the addition). glibc
# base so we don't fight aws-lc-rs on musl — the runtime below matches.
FROM rust:1-bookworm AS server

RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake clang \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/server
COPY server/ .
# rust-embed embeds ../web/dist (relative to the crate) at compile time, so the
# built SPA must be in place before the release build.
COPY --from=web /app/web/dist /app/web/dist
RUN cargo build --release --features embed-spa

# Stage 3: Minimal runtime (glibc, matching the build stage)
FROM debian:bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=server /app/server/target/release/atmin-server /atmin

# Rocket binds 127.0.0.1 by default — invisible from outside the container. Bind
# all interfaces on the platform's port (Scaleway routes to 8080, same as Go's
# LISTEN_ADDR default). SERVER_SECRET / S3_* env carry over unchanged; LISTEN_ADDR
# is Go-only and simply ignored. `/atmin cleanup` still works (arg dispatch).
ENV ROCKET_ADDRESS=0.0.0.0 \
    ROCKET_PORT=8080
EXPOSE 8080
ENTRYPOINT ["/atmin"]
