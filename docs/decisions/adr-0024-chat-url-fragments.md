# ADR-0024: Chat URLs as client-side fragments

Status: Draft
Date: 2026-06-21

Complements [ADR-0013](adr-0013-user-chosen-handles.md) (the `/@{handle}`
convention for people). Constrains, but does not pre-empt, a future
group-chats ADR — it fixes only how a chat is *addressed*, not how its
membership or state is stored. Expresses the [vision.md](../vision.md)
boundary: the server is a dumb relay; clients own identity, keys, and trust.

## Context

People have a URL: `atmin.net/@{handle}`. A room (a multi-party chat, with
its own `group_id` distinct from any member) needs one too — for
deep-linking and, above all, invites. A path-based room URL works against
the architecture: on a cold load the SPA fallback ([spa.rs](../../server/src/spa.rs))
serves `index.html` for that exact path, so the room id lands in the request
line, the access log ([ADR-0010](adr-0010-logging.md)), and `Referer`.
The server would learn which rooms exist and who opens them — metadata it
otherwise refuses to hold.

## Decision

Address chats with a `#` sigil whose payload lives in the **URL fragment**:

```
atmin.net/#{chat-id}
```

`@` for people (path, public, server-resolvable), `#` for rooms (fragment,
private, client-only). The pairing is the legible one — `@user`
(Mastodon/Bluesky), `#channel`/`#alias` (Slack/IRC/Matrix).

The fragment is load-bearing, not cosmetic. `#` cannot be a path segment —
the browser never puts the fragment on the wire — so the room id is absent
from the request line, access logs, and the SPA fallback (a deep link is
served as a plain `GET /`), and is stripped from `Referer`. The same
property makes invites free: an invite link's join secret rides in the same
fragment, structurally prevented from reaching the relay (a capability URL).

The client reads `location.hash`; the declarative `BrowserRouter` ignores it
(not `HashRouter`). A small hash hook sits *alongside* the ADR-0013
pathname splat — `@` from `pathname`, `#` from `hash`, no collision.

**Scope: container only.** The fragment grammar (id-only vs. id-plus-secret),
where group state lives, and rekey are deferred to the group-chats ADR.
Fragment addressing fits either membership-authority model that ADR might
pick — ideal for a client-signed encrypted group-state blob (room id
invisible at every layer), still correct under a server-held membership list
(the server sees `group_id` on the `POST /v1/send` envelope, never via
navigation or logs). It biases toward the client-authoritative model without
forcing it.

## Consequences

- **+** Room id never in access logs or `Referer`; invite secrets ride the
  same fragment — both by URL grammar, not a scrubbing policy that could
  regress. No new server surface.
- **+** `@` people / `#` rooms reads correctly on first sight.
- **−** Routing asymmetry: `@` on `pathname`, `#` on `hash` — two
  mechanisms, a little more router code. No server-side preview/SSR for a
  room (fine — nothing to preview). Abuse controls must key on identity and
  the envelope, never the URL the relay never sees.
- **−** Honest asymmetry with 1:1: `/@alice` still appears in access logs
  (handles are public by design — ADR-0013), a room `#…` does not.
- Status stays **Draft** until the group-chats ADR ratifies the
  membership/state model this addressing serves; accept them together.

## Alternatives considered

- **`--`, `-`, `@@` sigils** — no established meaning, read as flags or
  typos, and would be path segments with all the leakage that implies. `#`
  alone carries the room metaphor *and* yields fragment semantics. Rejected.
- **Path-based room URLs (`/c/{id}`)** — server-routable and SSR-friendly,
  but leak the room id into logs and `Referer` on every cold load, with no
  place for an invite secret. Contradicts the dumb-relay boundary. Rejected.
- **A public, server-resolvable room alias** (like handle resolution) —
  would reverse the boundary this ADR protects. Whether a room ever also
  gets such an alias is a question for the group-chats ADR, not a default.
