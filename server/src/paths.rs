//! S3 key construction + per-prefix authorization.

pub fn key_profile(user_id: &str) -> String {
    format!("users/{user_id}/profile.json")
}

pub fn key_device(user_id: &str, device_id: &str) -> String {
    format!("users/{user_id}/devices/{device_id}.json")
}

pub fn key_handle(handle: &str) -> String {
    format!("handles/{handle}.json")
}

/// The `media/{user_id}/` prefix — the quota subsystem scans it to total usage.
pub fn prefix_media(user_id: &str) -> String {
    format!("media/{user_id}/")
}

/// The four owner-scoped prefixes a profile delete wipes (`users/`, `inbox/`,
/// `keys/`, `media/`, each scoped to the user).
pub fn prefix_user(user_id: &str) -> String {
    format!("users/{user_id}/")
}

pub fn prefix_inbox(user_id: &str) -> String {
    format!("inbox/{user_id}/")
}

/// The live / archive inbox subprefixes — `inbox/{uid}/live/` and
/// `inbox/{uid}/archive/`. The cleanup routine probes both to decide whether an
/// inbox is empty.
pub fn prefix_inbox_live(user_id: &str) -> String {
    format!("inbox/{user_id}/live/")
}

pub fn prefix_inbox_archive(user_id: &str) -> String {
    format!("inbox/{user_id}/archive/")
}

pub fn prefix_keys(user_id: &str) -> String {
    format!("keys/{user_id}/")
}

/// The device subtree — `users/{user_id}/devices/`. Used to spot device keys among
/// a profile-delete's listing so their cache entries can be evicted.
pub fn prefix_user_devices(user_id: &str) -> String {
    format!("users/{user_id}/devices/")
}

/// A live inbox message key — `inbox/{user_id}/live/{msg_id}`.
/// `send` writes each delivered envelope here.
pub fn key_inbox_live(user_id: &str, msg_id: &str) -> String {
    format!("inbox/{user_id}/live/{msg_id}")
}

/// A rotation idempotency record — `users/{user_id}/rotation-records/{request_id}.json`.
/// Swept after a 24h TTL by the cleanup job.
pub fn key_rotation_record(user_id: &str, request_id: &str) -> String {
    format!("users/{user_id}/rotation-records/{request_id}.json")
}

const USERS_ROOT: &str = "users/";
const DATA_PREFIXES: [&str; 3] = ["inbox/", "keys/", "media/"];

/// Whether `user_id` may access `prefix`: a user's own `inbox/`/`keys/`/`media/`
/// subtree, plus any `users/…` path (profile and key reads are intentionally
/// public — resolve, key fetch).
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
/// envelope). The write path stays owner-only.
pub fn authorize_key(user_id: &str, key: &str) -> bool {
    authorize_prefix(user_id, key) || key.starts_with("media/")
}

/// Whether `user_id` may *write* `key`. Like [`authorize_key`] but owner-only:
/// the public `media/` read capability and the public `users/…` read are both
/// dropped — only the caller's own data subtree and own `users/{uid}/` are
/// writable.
pub fn authorize_key_write(user_id: &str, key: &str) -> bool {
    for p in DATA_PREFIXES {
        if key.starts_with(&format!("{p}{user_id}/")) {
            return true;
        }
    }
    key.starts_with(&format!("{USERS_ROOT}{user_id}/"))
}

/// Whether `key` is a valid S3/MinIO object name: no empty path segment
/// (a leading, trailing, or doubled `/`). A raw base64 `session_id`
/// interpolated into a key can violate this (`XMinioInvalidObjectName`, 400);
/// the client encodes it base64url, and this is the server-side belt so a
/// future client bug fails loudly here at the API instead of silently at the
/// S3 PUT (invariant I10).
pub fn is_object_name_safe(key: &str) -> bool {
    !key.is_empty() && !key.starts_with('/') && !key.ends_with('/') && !key.contains("//")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn object_name_safety_rejects_empty_segments() {
        // Valid object names.
        assert!(is_object_name_safe("keys/u1/live/a-b_c"));
        assert!(is_object_name_safe("media/u1/01ABC"));
        // The XMinioInvalidObjectName shapes a raw session_id can produce.
        assert!(!is_object_name_safe("keys/u1/live//abc")); // doubled
        assert!(!is_object_name_safe("keys/u1/live/abc/")); // trailing
        assert!(!is_object_name_safe("/keys/u1/live/abc")); // leading
        assert!(!is_object_name_safe("")); // empty
    }

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

    #[test]
    fn authorize_key_write_is_owner_only() {
        // Own data subtree and own users/ path are writable.
        assert!(authorize_key_write("u1", "inbox/u1/live/m"));
        assert!(authorize_key_write("u1", "media/u1/01ABC"));
        assert!(authorize_key_write("u1", "users/u1/profile.json"));

        // No public media write, no other-user write, no foreign users/ path.
        assert!(!authorize_key_write("u1", "media/u2/01ABC"));
        assert!(!authorize_key_write("u1", "inbox/u2/live/m"));
        assert!(!authorize_key_write("u1", "users/u2/profile.json"));
    }
}
