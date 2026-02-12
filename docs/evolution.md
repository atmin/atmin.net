# Evolution notes

This document captures likely future evolution paths of the system.
It is **not a roadmap or a commitment**.

The purpose is to preserve context, design intent, and known trade-offs,
so future changes do not require rediscovering the same discussions.

---

## Real-time delivery (optional optimization)

- v0.1 treats realtime delivery as a best-effort optimization.
- Sync from storage is the authoritative delivery mechanism.
- Future improvements may include:
  - WebSocket-based "new mail" hints,
  - cross-instance fanout via a shared pub/sub layer.

These optimizations must not become correctness dependencies.

---

## Discovery and identity (deferred)

- v0.1 uses invite-based discovery only.
- No phone numbers, email addresses, or address book access are required.
- Invite handles are resolved via S3 lookup objects (`invites/{handle}.json`).

Future directions (opt-in, undecided):
- Public identifier discovery (e.g. verified phone numbers).
- Privacy-preserving contact matching.
- Additional identity claims layered on top of the existing model.

When discovery needs grow beyond S3 GET lookups, a cache layer (e.g. Redis) can be
introduced. S3 remains the source of truth; the cache is reconstructable by scanning
S3 prefixes (`invites/`, `users/`, `discovery/`). Cache loss causes discovery downtime,
not data loss. Index objects follow a convention:

- `invites/{invite_handle}.json` — invite lookup (v0.1)
- `discovery/phone/{hash}.json` — phone lookup (v0.2+, opt-in)
- `discovery/username/{name}.json` — username lookup (v0.2+, opt-in)

---

## Guiding principle

Evolution should favor:
- additive changes over breaking rewrites,
- client-side intelligence over server-side state,
- simple failure modes over complex coordination.

If a change requires centralized state, it must be clearly justified
and documented via an ADR.
