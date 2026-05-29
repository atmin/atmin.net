# ADR-0013: User-chosen handles

Status: Accepted
Date: 2026-05-25 (accepted 2026-05-29)

Builds on [ADR-0005](adr-0005-profiles-and-contacts.md) (two-file
profile/handle model) and [ADR-0007](adr-0007-registration-abuse-prevention.md)
(PoW + Turnstile gates on registration). Supersedes the
auto-generation portion of `IDs & naming > handle` in
[docs/specs/mvp-v0.1.md](../specs/mvp-v0.1.md).

## Context

The server today generates a two-BIP39-word handle at registration
([server/handle.go](../../server/handle.go)) and retries up to ten
times on collision. Across ~4M random combinations this is
race-tolerant by accident — the collision probability is vanishing.

The handle is what humans share ("DM me on atmin: copper-falcon")
and is the only user-facing identifier. Users find auto-assigned
handles forgettable; the typical reaction is "let me look it up"
rather than "I'm `copper-falcon`." Custom handles fix the recall
problem at the cost of three new concerns:

1. **Race-free uniqueness** — popular handles (`alice`, `admin`)
   will be requested concurrently, where `HeadObject + PutObject`
   races meaningfully.
2. **Namespace pollution** — squatting common names, system-like
   names, slurs.
3. **Reclamation after account deletion** — letting a fresh
   registration take over a freshly-deleted handle enables
   impersonation against the old owner's contacts.

This ADR addresses all three within the existing storage and
trust model — no new infrastructure beyond what's already in
flight (PoW + Turnstile from ADR-0007 raise the per-account cost
to a level where bulk squatting is at least uncomfortable).

## Decision

### Charset and length

```
^[a-z][a-z0-9-]{1,30}[a-z0-9]$
```

In words:

- Lowercase ASCII letters, digits, and hyphens only.
- 3–32 characters total.
- First character must be a letter (forbids `01abc`).
- Last character may not be a hyphen.
- No consecutive hyphens (`foo--bar` rejected).

No Unicode: homoglyph attacks (`a` vs Cyrillic `а`) are off the
table entirely. Case-insensitive matching is unnecessary because
there's only one case to match.

### Reserved list

A static file `server/reserved_handles.txt`, embedded in the
binary the same way `bip39_english.txt` is, one handle per line.
Loaded at server boot, all entries lowercased and trimmed. v0.1
list:

```
admin root atmin system support help info api www mail abuse
postmaster security anonymous deleted me
```

(System routes — `login`, `register`, `settings`, `saved` — do
**not** need to be reserved. PWA routes for users live under the
`/@` prefix; see *UI routing* below.)

The file path is overridable via `RESERVED_HANDLES_PATH` env var
for operator control without a rebuild.

### Atomic claim via in-server mutex

The natural primitive for atomic handle creation is `PutObject`
with `If-None-Match: *` (conditional create). The production
object storage backend does not support request preconditions
(see [ops.md — Object storage constraints](../ops.md#object-storage-constraints)),
so the design uses an in-process mutex instead.

The server claims a handle by acquiring a per-handle Go mutex,
performing the read-validate-write sequence inside the mutex, and
releasing on completion. The mutex map (`sync.Map<string, *sync.Mutex>`)
holds an entry only while a claim is in flight; idle entries are
reclaimed by a periodic sweep.

Two concurrent registrations of the same handle serialize: one
acquires the mutex, sees the handle is free, writes, releases.
The next acquires, sees the just-written file, rejects with
`409 handle_taken`. No race window.

This matches [ADR-0012](adr-0012-backup-secret-rotation.md)'s
rotation-mutex pattern. Both are valid because the production
server is currently single-process. The deployment-and-state model
is:

- Durable state on S3 (per [ADR-0001](adr-0001-sync-first-s3-mailbox.md)).
- In-process state for coordination and caching (SSE hub,
  device-existence cache, profile-`key_version` cache, media-quota
  cache, and now the rotation and handle-claim mutexes).
- "Stateless by design" means S3 is the durable source of truth,
  not that the server holds no in-memory state.

**Multi-instance migration path.** If the server is later scaled
horizontally, all in-process coordination state (mutex maps,
caches, SSE hub) needs to move to shared state. A future ADR will
pick the substrate (Redis SETNX, Postgres advisory locks, etc.)
and migrate these primitives coherently. The handle-claim mutex
joins that list; it does not create new architectural debt beyond
what's already there for the other primitives.

**Degraded mode.** When the system is later multi-instance and the
shared coordination store is unreachable, the handle-claim mutex
is unavailable. Registration returns `503 registration_unavailable`
in that case. Single-instance deployments never emit this; the
in-process mutex is always available as long as the server is
serving requests.

### Registration flow

After PoW + Turnstile (ADR-0007) pass:

1. Validate the requested handle: charset, length, reserved list.
   Reject `400 handle_invalid` (format) or `400 handle_reserved`
   (blocklist match) — distinct codes so the client can render
   distinct messages.
2. **Acquire the per-handle mutex.** If another in-flight
   registration holds it, block briefly with a short timeout
   (~500 ms). On timeout, return `503 registration_unavailable` —
   the server is genuinely under contention on this handle (or
   the previous holder is stuck), and the user should retry.
3. `GET handles/{handle}.json`. Possible outcomes:
   - 404 → handle is free; proceed to step 5.
   - 200 with live projection (no `released_at`) → reject
     `409 handle_taken`.
   - 200 with `released_at` field, timestamp in the future →
     reject `409 handle_in_cooldown` (body includes `released_at`
     so the client can render "available on YYYY-MM-DD").
   - 200 with `released_at` in the past → tombstone is expired
     but hasn't been GC'd yet. `DeleteObject` the tombstone,
     then continue to step 4.
4. Generate `user_id` (ULID), `device_id` (ULID), and the new
   `token`.
5. `PutObject handles/{handle}.json` (unconditional) carrying the
   projection (user_id, sharing_public_key, salt, kdf,
   key_version, …). The mutex held since step 2 makes the
   GET-then-PUT sequence effectively atomic for this handle:
   no other registration can have read 404 and not yet
   written, so an unconditional `PUT` is safe.
6. Write `users/{user_id}/profile.json` and
   `users/{user_id}/devices/{device_id}.json`. If either fails,
   best-effort `DeleteObject` the handle projection and return
   the underlying error. The handle returns to the free pool;
   the user_id is abandoned (no profile, no token issued).
7. Release the mutex.

The `user_id` is freshly generated in step 4 — if registration
fails in step 6, the user_id is never returned to the client, so
its abandonment is invisible.

Steps 3 and 5 deliberately happen **inside the mutex**. Without
that wrapper, two concurrent registrations of the same handle
could both observe 404 in step 3 and both PUT in step 5, with the
second silently overwriting the first. The mutex closes this
race; given the backend constraint
([ops.md — Object storage constraints](../ops.md#object-storage-constraints))
it's the only way to close it.

### Deleted-handle cooldown (30 days)

`DELETE /v1/profile` no longer removes `handles/{handle}.json`.
Instead the server **rewrites** it as a tombstone:

```jsonc
{
  "released_at": "2026-06-25T10:30:00Z"
}
```

All other fields are dropped. The rewrite uses an unconditional
`PutObject` (no If-Match) — there's nothing to race against,
since the only writer is the same account holder via the same
endpoint, authenticated by their (about-to-be-invalidated) token.

While `released_at` is in the future:

- `GET /v1/resolve/{handle}` returns `410 Gone` with body
  `{ "released_at": "...", "available_at": "..." }`. The 410
  is semantically right ("was here, gone now") and lets the
  client distinguish a cooldown from a never-registered handle
  (which stays 404). `available_at` is `released_at + 30d`,
  precomputed for client convenience.
- Registration on the handle returns `409 handle_in_cooldown`.

After `released_at + 30d`:

- The cleanup routine ([server-cleanup-routine](../../tasks/server-cleanup-routine.md))
  deletes the tombstone. The handle becomes claimable.
- Registrations between expiry and cleanup catch this in step 2.4
  (delete-then-claim) — the cooldown is enforced at the millisecond
  level, not at the cleanup-cadence level.

30 days is enough to cover a "I deleted by accident" recovery
window for the original owner, without making the namespace
unusable. The reservation is symmetric: the previous owner does
not get a preferential re-claim during cooldown either — if the
attacker waits 30 days, the legitimate owner waits 30 days. We
trade one form of impersonation risk (immediate takeover) for a
slower, harder-to-exploit one (planned takeover).

### UI routing convention

PWA routes for users use the `/@` prefix:
`app.atmin.net/@{handle}`. System routes (`/login`, `/register`,
`/settings`, `/saved`) stay where they are. The `@` is a
URL-level convention used by Mastodon, Bluesky, and friends — it
visually flags "this is a person" and eliminates the namespace
collision between user URLs and system routes.

The `@` is **UI-only**:

- `GET /v1/resolve/{handle}` keeps the bare handle (no `@`).
- S3 keys keep the bare handle (no `@`).
- The `Profile.handle` field stores the bare handle.

The `@` is added at URL-construction sites in
[ChatsView.tsx](../../web/src/components/ChatsView.tsx) and
[chats.tsx](../../web/src/routes/chats.tsx).

**Routing implementation note.** The intended React Router pattern
was `path="/@:handle"`, but React Router v7 (current version: v7.13)
does not support partial-segment dynamic patterns — `:`-prefixed
parameters must own a whole URL segment, so `/@:handle` never
matches `/@alice-test`. The actual implementation in
[app.tsx](../../web/src/routes/app.tsx) uses a splat route
(`path="*"`) at the end of the route list and discriminates inside a
wrapper component: paths starting with `/@` whose suffix passes
`validateHandleShape` render the chat, `/saved` renders Saved
Messages, everything else renders a 404. User-visible URLs are
unchanged. If/when React Router gains partial-segment support, the
splat can be replaced with the original `path="/@:handle"` form
without a URL change.

### "Surprise me"

The registration form offers a "Surprise me" button next to the
handle input. The button runs a client-side BIP39 random generator;
the `@scure/bip39` wordlist is bundled for this purpose. No server
endpoint, so the generator cannot be abused to fish for free random
handles at scale.

### Availability check at registration

Real-time availability uses the existing `GET /v1/resolve/{candidate}`
endpoint with the three response codes (200 / 404 / 410)
described above. The client debounces 300 ms. No new endpoint.
Active enumeration of the namespace via the resolve endpoint
remains possible — it is today too. Rate limiting on resolve is
a follow-up if abuse appears.

## Consequences

### Positive

- Users get the handle they want. The biggest onboarding-friction
  WTF moment goes away.
- Atomic claim eliminates the existing collision-race surface,
  even though that surface is theoretical at current scale.
- Reserved list catches obvious system-imposter handles.
- Cooldown raises the cost of post-deletion impersonation from
  "click fast" to "wait 30 days" — non-zero but bounded.
- The reserved list shrinks now that the `@` prefix removes
  system-route collisions. Less drift between routes and handle
  policy over time.

### Negative

- One additional S3 GET on the registration path (the
  look-before-leap inside the mutex). Adds a few tens of
  milliseconds; trivial compared to the PoW+Turnstile gates.
- PoW + Turnstile (~$0.005–$0.01 per account) are the floor on
  squatting cost. Squatting 1000 short common handles costs $5–10.
  Annoying but not catastrophic at our scale; PoW difficulty can
  be raised as a knob if abuse appears.
- The in-process handle-claim mutex makes registration a
  single-instance-only operation. Multi-instance deployment
  requires moving the mutex (and all other in-process state) to
  shared coordination, covered by a future ADR.
- Cooldown adds operational surface to the cleanup routine: it
  now needs to walk `handles/*.json` filtering by `released_at`
  in addition to its existing inactive-account sweep.

### Neutral

- The handle is still a string. The system-internal identifier
  (`user_id`, ULID) is unchanged. No downstream code needs to
  reason about handle format.
- The two-file profile/handle model from ADR-0005 stays intact.
  The `handles/{handle}.json` projection just gains an optional
  `released_at` field and is allowed to exist with only that
  field present.
- The legacy auto-generated BIP39 handles already in
  `handles/*.json` are valid under the new charset (lowercase
  letters + hyphen) and remain claimed by their existing owners.
  No migration needed.

## Migration

Local-dev test accounts can be wiped (this is the same migration-
rehearsal stance as ADR-0011). For staging, existing accounts
keep their auto-generated handles — those handles are syntactically
valid under the new rules, just not what the owner would have
picked. A future task could add "rename my handle" (out of scope
here; see *Alternatives*).

## Alternatives considered

### Drop the `@` prefix; rely on the reserved list

Rejected. The reserved list would have to include every current
and *future* system route name (`login`, `register`, `settings`,
`saved`, anything added later) — and reserved-list drift would
become a routine bug source ("we added `/billing` but forgot to
reserve it"). The `@` prefix puts the namespaces in different
universes once, structurally.

### Allow handle rename in this task

Rejected. Rename raises its own design questions: what happens
to the old handle (immediate release? cooldown? permanent
tombstone?), how do contacts learn about the rename, how do old
URLs route to the new handle. These deserve a separate ADR. v0.1
ships with immutable handles; the user picks once at registration.

### Use a separate `released-handles/` prefix for tombstones

Rejected. Two prefixes mean the registration flow has to check
both, and the resolve endpoint has to read both to decide between
404 and 410. Single-file model with an optional `released_at`
field is one path, one decision, one race surface.

### Profanity / slur filter at registration

Rejected for v0.1. Filtering requires either an external service
(violates privacy-first stance) or a maintained list (subjective
and contested). The reserved list catches system-imposter cases;
broader UGC moderation is a separate problem with a separate
toolset.

### HeadObject + PutObject without serialization

Rejected for chosen handles. Random handles barely race at all;
chosen handles will race deterministically on every popular name.
Retry doesn't fix the race — it just gives one client a more
graceful loss. The in-server mutex is the right primitive given
the backend constraint.

### Switching to a backend that supports `If-None-Match: *`

Considered. AWS S3 (2024-08), Cloudflare R2, MinIO and other
non-EU-resident options all support request preconditions; among
EU-resident S3-compatible providers, support varies and would
need verification. The EU-resident infrastructure stance
([ops.md](../ops.md#operational-stance-eu-resident-infrastructure))
narrows the choice; for v0.1 the chosen provider doesn't support
preconditions, so the design adapts. If a future backend swap
brings preconditions back into reach, the mutex pattern can be
revisited.

### S3-only fencing protocol (intent files + settling window)

Considered. A two-phase claim protocol: every registration writes
its proposed handle as `handles/{handle}/intent-{ulid}.json`,
waits ~3 s for any concurrent intents to land, then `ListObjects`
to identify the earliest intent (sorted by Last-Modified, ULID
tiebreaker) — earliest wins.

Rejected for v0.1 because it adds 2–3 s of mandatory latency to
every registration, and the in-server mutex closes the same race
window at zero latency cost on the current single-instance
deployment. The fencing protocol becomes a candidate if and when
the server moves to multi-instance and the chosen shared-state
substrate is unavailable — pinned here so future-us can pick it
up coherently.

### Reserve handles preferentially for the original owner after deletion

Rejected. Requires the server to remember who owned a handle
after deletion (privacy regression) and creates a "you can come
back, but only as your old self" UX that conflicts with the
account-deletion guarantee. Symmetric 30-day cooldown is simpler
and equally protective against attacker takeover.
