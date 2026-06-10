//! S3 key construction + per-prefix authorization. Mirrors `server/paths.go` and
//! the `authorizePrefix` helper from `server/handlers.go`.

pub fn key_profile(user_id: &str) -> String {
    format!("users/{user_id}/profile.json")
}

pub fn key_device(user_id: &str, device_id: &str) -> String {
    format!("users/{user_id}/devices/{device_id}.json")
}

pub fn key_handle(handle: &str) -> String {
    format!("handles/{handle}.json")
}

const USERS_ROOT: &str = "users/";
const DATA_PREFIXES: [&str; 3] = ["inbox/", "keys/", "media/"];

/// Whether `user_id` may access `prefix`. Mirrors `authorizePrefix`: a user's own
/// `inbox/`/`keys/`/`media/` subtree, plus any `users/…` path (profile and key
/// reads are intentionally public — resolve, key fetch).
pub fn authorize_prefix(user_id: &str, prefix: &str) -> bool {
    for p in DATA_PREFIXES {
        if prefix.starts_with(&format!("{p}{user_id}/")) {
            return true;
        }
    }
    prefix.starts_with(USERS_ROOT)
}

/// Whether `user_id` may *read* `key`. Like [`authorize_prefix`], plus: any
/// `media/` blob is readable by any authenticated caller — media is
/// capability-protected (the ULID path is delivered inside the encrypted
/// envelope). The write path stays owner-only. Mirrors `authorizeKey`.
pub fn authorize_key(user_id: &str, key: &str) -> bool {
    authorize_prefix(user_id, key) || key.starts_with("media/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn authorize_prefix_allows_own_data_and_any_user_path() {
        assert!(authorize_prefix("u1", "inbox/u1/live/"));
        assert!(authorize_prefix("u1", "keys/u1/live/"));
        assert!(authorize_prefix("u1", "media/u1/"));
        // Any users/… path is readable (public profile / key fetch).
        assert!(authorize_prefix("u1", "users/anyone/profile.json"));

        // Another user's data subtree is denied.
        assert!(!authorize_prefix("u1", "inbox/u2/live/"));
        assert!(!authorize_prefix("u1", "keys/u2/"));
        assert!(!authorize_prefix("u1", "media/u2/"));
        // An unknown root is denied.
        assert!(!authorize_prefix("u1", "random/u1/"));
    }

    #[test]
    fn authorize_key_adds_media_capability() {
        // Own data and any users/ path, same as authorize_prefix.
        assert!(authorize_key("u1", "inbox/u1/live/m"));
        assert!(authorize_key("u1", "users/anyone/profile.json"));
        // Any media blob is readable — even another user's (capability-protected).
        assert!(authorize_key("u1", "media/u2/01ABC"));
        // But another user's inbox/keys is still denied.
        assert!(!authorize_key("u1", "inbox/u2/live/m"));
        assert!(!authorize_key("u1", "keys/u2/live/s"));
    }
}
