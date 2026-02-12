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

## Usernames (invite handles → stable identifiers)

- v0.1 invite handles are server-generated opaque strings.
- If users could choose their handle (with uniqueness enforcement), handles become usernames.
- The resolve infrastructure (`invites/{handle}.json` → user_id) already supports this.
- A user could claim multiple handles (aliases).
- Only addition needed: a "claim handle" API with uniqueness check.

---

## Email gateway

If handles are stable identifiers, `{handle}@atmin.net` becomes a valid email address.
A gateway service would:

1. Receive email at `{handle}@atmin.net`.
2. Resolve handle → user_id + sharing_public_key (same as any client).
3. Encrypt the email body with the recipient's sharing key.
4. Deliver via `POST /v1/send` with `content_type: gateway.email`.

The gateway is just another writer using the public API.
Trust model: email is not E2E encrypted by nature — the gateway seeing plaintext
is inherent to email, not a new compromise. The recipient's client renders
gateway messages distinctly.

---

## Threads / topics (client-side conversations)

- v0.1 has no server-side concept of "conversations."
  Clients materialize chats by grouping messages by `from_user`.
- Multiple conversations between the same pair of users (e.g. per topic)
  can be supported by adding a `thread_id` inside the encrypted payload.
- Client groups by `(from_user, thread_id)` instead of just `from_user`.
- Zero server changes — pure client-side concept.
- Fits the "client-side intelligence over server-side state" principle.

---

## Guiding principle

Evolution should favor:
- additive changes over breaking rewrites,
- client-side intelligence over server-side state,
- simple failure modes over complex coordination.

If a change requires centralized state, it must be clearly justified
and documented via an ADR.
