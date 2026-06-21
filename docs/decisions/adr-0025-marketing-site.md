# ADR-0025: Marketing site — in-repo, static, on Scaleway

Status: Accepted
Date: 2026-06-21

## Context

`app.atmin.net` (production) and `staging.atmin.net` are the Rust container
serving the embedded SPA. The apex `atmin.net` points nowhere. It needs a
public face: what the project is, why its privacy stance matters, and where to
get the clients — the web app today, app-store and desktop builds later.

Three questions: where the source lives, what serves it, and what it's built
with.

A marketing page carries no user data and has no request/data path — it is
static brochureware that links out to `app.atmin.net`. That makes the
[ops.md](../ops.md) "EU-resident infrastructure" stance look, at first, like it
doesn't apply. But the stance is about *where the product lives*, and the apex
is the product's front door. `storybook.atmin.net` already ships from CI to
GitHub Pages — and that is fine precisely because Storybook is an internal
developer artifact, not the public face of a privacy product. The front door is
the one static surface where serving it from EU infra, on the same provider as
everything else, is a brand statement rather than an incidental hosting choice.

## Decision

**Source — same repo, new top-level `site/`.** The repo is already a deliberate
monorepo (`server/`, `web/`, `docs/`, `tasks/`); a new top-level area is the
established move. The payoff is atomic cross-cutting edits: when a native build
ships, the download CTA, a release note, and any scenario change in one commit,
with no cross-repo drift. The mark, the token palette, and the tagline are
shared with `web/` rather than re-derived.

**Build — Astro, static output.** Content-first, ships ~zero JS by default
(on-brand for a project that tracks gzip deltas), Tailwind-v4-native so the
`web/` token set carries over, and a React island remains available if a live
demo is ever wanted. The app's Vite/React stack would also work but pulls a
client runtime onto a brochure for no benefit.

**Serve — Scaleway Object Storage + Edge Services.** A public-read bucket holds
the built site; Edge Services fronts it as the CDN and terminates TLS for the
apex. Keeps the entire footprint EU-resident and single-provider, consistent
with the operational stance. `www.atmin.net` redirects to the apex. Deploy is a
path-filtered GitHub Actions workflow (`site/**` only) that builds and
`s3cmd sync`s to the bucket — independent of the app's `deploy.yml`, so brochure
edits never rebuild the messenger. Master push publishes; no tag ceremony (a
landing page has no e2e gate to clear).

## Consequences

- **+** Apex stays EU-resident and single-provider — the privacy product's
  front door matches its pitch.
- **+** In-repo + same toolchain conventions (`make site-*`, the shared token
  palette) keep the site a first-class citizen, not a side project that rots.
- **+** A separate workflow with a `site/**` path filter fully decouples the
  brochure's cadence from the messenger's deploy pipeline.
- **−** More one-time setup than GitHub Pages (bucket + public-read policy +
  Edge Services + apex DNS) — documented in [ops.md](../ops.md) "Marketing
  site"; a one-time cost.
- **−** Edge Services cache invalidation is a manual/scripted purge (or TTL
  expiry); the deploy syncs reliably, the purge is best-effort until wired to a
  secret. Acceptable for a low-churn brochure.
- **−** A second front-end project to keep on a current toolchain. Mitigated by
  the small surface and `astro check` gating the build.

## Alternatives considered

- **GitHub Pages** — fastest, free, CI-native, and already in use for
  `storybook.atmin.net`. Rejected *for the apex*: it puts the privacy product's
  public face on US infra (Microsoft/Fastly), a weaker-brand choice when the
  same CI can publish to the EU stack already in use. The Storybook precedent
  stands — an internal dev artifact, not the front door.
- **Serve the site from the existing app container at the apex** — one origin,
  one deploy. Rejected: couples brochure-copy edits to messenger redeploys (the
  container is always-on serving the SPA), and the apex/`www`/`app` routing
  split gets awkward.
- **A separate repository** — cleaner isolation, but loses the atomic
  cross-cutting edit (the whole reason download links and product copy want to
  move together) and fragments the single documentation-first surface.
- **Reuse the Vite/React app stack** — stack uniformity, but a client runtime on
  a static brochure with no interactivity to justify it.
