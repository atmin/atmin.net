//! Dev binary — an in-memory atmin server for poking at the implemented endpoints
//! by hand. NOT production: the store is `MemStore` (state is lost on restart),
//! there's no S3, no static SPA, no SSE, and only the handlers built so far. The
//! real S3-backed `#[launch]` lands in phase 4 (ADR-0018).
//!
//! Run from `server-rs/`:
//!   SERVER_SECRET=dev cargo run
//! then curl http://localhost:8000 (Rocket's default address/port).

use atmin_server::config::ServerConfig;
use atmin_server::routes;
use atmin_server::store::SharedStore;
use atmin_server::store_mem::MemStore;
use std::sync::Arc;

#[rocket::launch]
fn rocket() -> _ {
    let server_secret = std::env::var("SERVER_SECRET")
        .unwrap_or_else(|_| "dev-insecure-secret".into())
        .into_bytes();
    let store: SharedStore = Arc::new(MemStore::new());
    routes::build(store, ServerConfig { server_secret })
}
