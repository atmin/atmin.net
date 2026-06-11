//! Embedded single-page app, served as the catch-all GET fallback with
//! client-side-routing support. Compiled only under the `embed-spa` feature so the
//! default build stays independent of a web build.
//!
//! `rust-embed` embeds `../web/dist` into the binary for release builds (yielding
//! a single self-contained binary); in debug it reads the same files from disk at
//! runtime, so a `pnpm build` is picked up without recompiling the server.

use rocket::get;
use rocket::http::ContentType;
use rust_embed::RustEmbed;
use std::path::PathBuf;

#[derive(RustEmbed)]
#[folder = "../web/dist"]
struct Assets;

/// Serve a static asset, falling back to `index.html` for any unknown path so the
/// client router can handle it (the SPA fallback). Ranked last so every API route
/// matches first. `None` (404) only if `index.html` itself is absent (no build).
#[get("/<path..>", rank = 20)]
pub fn spa(path: PathBuf) -> Option<(ContentType, Vec<u8>)> {
    let requested = path.to_str().unwrap_or("");
    let key = if requested.is_empty() {
        "index.html"
    } else {
        requested
    };
    let asset = Assets::get(key).or_else(|| Assets::get("index.html"))?;
    // rust-embed guesses the mimetype at embed time (knows .wasm, .js, …); fall
    // back to octet-stream if it's somehow unparseable.
    let content_type =
        ContentType::parse_flexible(asset.metadata.mimetype()).unwrap_or(ContentType::Bytes);
    Some((content_type, asset.data.into_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rocket::http::Status;
    use rocket::local::blocking::Client;
    use rocket::routes;

    // These run only with `--features embed-spa` and require ../web/dist to exist.
    fn client() -> Client {
        Client::tracked(rocket::build().mount("/", routes![spa])).unwrap()
    }

    #[test]
    fn serves_index_at_root() {
        let c = client();
        let resp = c.get("/").dispatch();
        assert_eq!(resp.status(), Status::Ok);
        assert_eq!(resp.content_type(), Some(ContentType::HTML));
        assert!(resp.into_string().unwrap().contains("<html"));
    }

    #[test]
    fn unknown_path_falls_back_to_index() {
        // A client-side route the server has no file for → SPA index, not 404.
        let c = client();
        let resp = c.get("/some/client/route").dispatch();
        assert_eq!(resp.status(), Status::Ok);
        assert_eq!(resp.content_type(), Some(ContentType::HTML));
    }
}
