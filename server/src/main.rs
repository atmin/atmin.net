//! atmin server binary: the same binary runs either the HTTP server (default) or
//! the one-shot `cleanup` maintenance task.
//!
//! Store selection: if `S3_ENDPOINT` is set, build the S3-backed store from the
//! `S3_*` env (production, and local dev against MinIO); otherwise fall back to
//! the in-memory store so the endpoints can be exercised over HTTP without any S3.
//!
//! Run from `server/`:
//!   SERVER_SECRET=dev cargo run                       # MemStore (no S3)
//!   SERVER_SECRET=… S3_ENDPOINT=… … cargo run          # S3-backed server
//!   S3_ENDPOINT=… … cargo run -- cleanup [--apply]     # retention sweep (S3 only)
//!
//! Listen address/port is Rocket's own config (ROCKET_ADDRESS / ROCKET_PORT,
//! default 127.0.0.1:8000).

use atmin_server::cleanup::{run_cleanup, CleanupOpts};
use atmin_server::config::{S3Config, ServerConfig};
use atmin_server::logging;
use atmin_server::routes;
use atmin_server::store::SharedStore;
use atmin_server::store_mem::MemStore;
use atmin_server::store_s3::S3Store;
use chrono::Utc;
use rocket::{Build, Rocket};
use std::sync::Arc;

#[rocket::main]
async fn main() {
    // Install the logfmt logger before Rocket builds (so Rocket defers to it) and
    // before the cleanup path, which logs too. ADR-0010 / logging.rs.
    logging::init();

    // Subcommand dispatch: same image, either the server or the cleanup job
    // (a scheduled Scaleway Serverless Job — see docs/ops.md).
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("cleanup") {
        run_cleanup_cmd(&args[2..]).await;
        return;
    }

    if let Err(e) = build_server().launch().await {
        eprintln!("server failed: {e}");
        std::process::exit(1);
    }
}

/// Build the HTTP server over an S3 store (if `S3_ENDPOINT` is set) or the
/// in-memory fallback.
fn build_server() -> Rocket<Build> {
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
            eprintln!("invalid S3 configuration: {e}");
            std::process::exit(1);
        }
    };

    routes::build(store, ServerConfig { server_secret })
}

/// Run the retention sweep against S3. Dry-run unless `--apply` is passed. Reads
/// `CLEANUP_INACTIVE_DAYS` (default 180) and `CLEANUP_BATCH_SIZE` (default 100).
async fn run_cleanup_cmd(args: &[String]) {
    let apply = args.iter().any(|a| a == "--apply");

    // Cleanup is meaningless against the in-memory store, so S3 is required.
    let s3 = match S3Config::from_env() {
        Ok(Some(s3)) => s3,
        Ok(None) => {
            eprintln!("cleanup requires S3 (S3_ENDPOINT is unset)");
            std::process::exit(1);
        }
        Err(e) => {
            eprintln!("invalid S3 configuration: {e}");
            std::process::exit(1);
        }
    };
    let store: SharedStore = Arc::new(S3Store::new(&s3));

    let opts = CleanupOpts {
        inactive_days: env_i64("CLEANUP_INACTIVE_DAYS", 180),
        batch_size: env_usize("CLEANUP_BATCH_SIZE", 100),
        dry_run: !apply,
        now: Utc::now(),
    };

    match run_cleanup(&store, &opts).await {
        Ok(r) => eprintln!(
            "cleanup done: scanned={} abandoned={} inactive={} tombstones={} deleted={} errors={} dry_run={}",
            r.handles_scanned, r.abandoned, r.inactive, r.tombstones, r.deleted, r.errors, opts.dry_run
        ),
        Err(e) => {
            eprintln!("cleanup failed: {e}");
            std::process::exit(1);
        }
    }
}

fn env_i64(key: &str, fallback: i64) -> i64 {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}

fn env_usize(key: &str, fallback: usize) -> usize {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(fallback)
}
