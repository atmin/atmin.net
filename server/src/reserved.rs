//! Reserved-handle blocklist (ADR-0013).
//!
//! The blocklist is the embedded `reserved_handles.txt`; the `RESERVED_HANDLES_PATH`
//! operator override described in ADR-0013 is not wired up — only the embedded
//! list is honored.

use std::collections::HashSet;
use std::sync::OnceLock;

const RESERVED_HANDLES: &str = include_str!("reserved_handles.txt");

fn reserved_set() -> &'static HashSet<String> {
    static SET: OnceLock<HashSet<String>> = OnceLock::new();
    SET.get_or_init(|| {
        RESERVED_HANDLES
            .lines()
            .filter_map(|line| {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') {
                    None
                } else {
                    Some(line.to_lowercase())
                }
            })
            .collect()
    })
}

/// Whether `handle` is on the reserved blocklist. The handle is assumed already
/// lowercased (the charset rule forces lowercase), so the comparison is direct.
pub fn is_reserved(handle: &str) -> bool {
    reserved_set().contains(handle)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_system_names_only() {
        assert!(is_reserved("admin"));
        assert!(is_reserved("root"));
        assert!(is_reserved("postmaster"));
        assert!(!is_reserved("alice"));
        assert!(!is_reserved("copper-falcon"));
    }
}
