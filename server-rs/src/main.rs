//! atmin server binary. Mirrors `server/main.go`'s `runServer`.
//!
//! Store selection (the phase-4 wiring): if `S3_ENDPOINT` is set, build the
//! S3-backed store from the `S3_*` env (production, and local dev against MinIO);
//! otherwise fall back to the in-memory store so the implemented endpoints can be
//! exercised over HTTP without any S3 — the dev convenience from phase 3.
//!
//! Run from `server-rs/`:
//!   SERVER_SECRET=dev cargo run                       # MemStore (no S3)
//!   SERVER_SECRET=… S3_ENDPOINT=… S3_BUCKET=… \
//!     S3_ACCESS_KEY=… S3_SECRET_KEY=… cargo run        # S3-backed
//!
//! Listen address/port is Rocket's own config (ROCKET_ADDRESS / ROCKET_PORT,
//! default 127.0.0.1:8000), not Go's LISTEN_ADDR. Static SPA + SSE + CORS are
//! still later phases.

use atmin_server::config::{S3Config, ServerConfig};
use atmin_server::routes;
use atmin_server::store::SharedStore;
use atmin_server::store_mem::MemStore;
use atmin_server::store_s3::S3Store;
use std::sync::Arc;

#[rocket::launch]
fn rocket() -> _ {
    let server_secret = std::env::var("SERVER_SECRET")
        .unwrap_or_else(|_| "dev-insecure-secret".into())
        .into_bytes();

    let store: SharedStore = match S3Config::from_env() {
        Ok(Some(s3)) => {
            eprintln!("store: S3 (bucket={}, endpoint={})", s3.bucket, s3.endpoint);
            Arc::new(S3Store::new(&s3))
        }
        Ok(None) => {
            eprintln!("store: in-memory (S3_ENDPOINT unset) — state is lost on restart");
            Arc::new(MemStore::new())
        }
        Err(e) => {
            // S3_ENDPOINT was set but the config is incomplete — fail loudly.
            eprintln!("invalid S3 configuration: {e}");
            std::process::exit(1);
        }
    };

    routes::build(store, ServerConfig { server_secret })
}
