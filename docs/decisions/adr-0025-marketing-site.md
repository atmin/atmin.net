# ADR-0025: Marketing site — in-repo, static, on GitHub Pages

Status: Accepted
Date: 2026-06-22

## Context

`app.atmin.net` (production) and `staging.atmin.net` are the Rust container
serving the embedded SPA. The apex `atmin.net` points nowhere and needs a public
face: what the project is, why its privacy stance matters, and where to get the
clients — the web app today, app-store and desktop builds later.

Three questions: where the source lives, what builds it, and what serves it. The
hard constraint is the **apex** — `atmin.net` itself must serve over HTTPS,
because that's the address people type and the one the brand uses.

## Decision

**Source — same repo, new top-level `site/`.** The repo is already a deliberate
monorepo (`server/`, `web/`, `docs/`, `tasks/`); a new top-level area fits. The
payoff is atomic cross-cutting edits: when a native build ships, the download
CTA, a release note, and any scenario change land in one commit, no cross-repo
drift. The mark, token palette, and tagline are shared with `web/`.

**Build — Astro, static output.** Content-first, ~zero JS by default (on-brand
for a project that tracks gzip deltas), Tailwind-v4-native so the `web/` token
set carries over, with a React island available if a live demo is ever wanted.

**Serve — GitHub Pages.** It serves the **bare apex** `atmin.net` over HTTPS with
an auto-provisioned (Let's Encrypt) certificate — apex `A`/`AAAA` records to
GitHub's addresses plus a `www` `CNAME` — at zero cost and zero infrastructure.
It's CI-native (the repo is already on GitHub) and the exact mechanism already
in use for `storybook.atmin.net` (`peaceiris/actions-gh-pages` + a `CNAME`).
Deploy is a path-filtered workflow on `site/**`, independent of the app's
`deploy.yml`; a master push publishes.

## Consequences

- **+** The apex works, with free managed TLS — the address people type
  resolves, no Load Balancer, no per-month cost.
- **+** Zero infrastructure to operate; the same deploy path already proven for
  Storybook.
- **+** In-repo + shared toolchain keep the site a first-class citizen, not a
  side project that rots.
- **−** US-hosted (Microsoft/Fastly). Accepted: the brochure carries **no user
  data and has no request/data path** — it's static HTML linking to
  `app.atmin.net`. The EU-resident stance ([ops.md](../ops.md)) is about the
  product's *data path*, where GitHub/CI is already an acknowledged exception.
  For a no-PII front door, shipping on the apex beats provider purity —
  **pragmatic is better than pure**.
- **−** A second front-end project to keep on a current toolchain; mitigated by
  its small surface and `astro check` gating the build.

## Alternatives considered

- **Scaleway Object Storage + Edge Services** — would keep the marketing front
  door on the same EU-resident footprint as the app. **Rejected: Edge Services
  is subdomain-only and cannot serve a bare apex** — its mechanism is a CNAME,
  which by definition can't exist at an apex
  ([Scaleway docs](https://www.scaleway.com/en/docs/edge-services/reference-content/cname-record/),
  [open feature request](https://feature-request.scaleway.com/posts/983/add-support-for-root-apex-custom-domains-for-edge-services)).
  The only Scaleway path to apex HTTPS is a Load Balancer (~10× the app's
  monthly cost) — disproportionate for a brochure. Verify that a provider
  actually supports what a decision needs *before* relying on it (see the
  [ADR process notes](README.md)).
- **Serve the site from the app container at the apex** — one origin, but
  couples brochure edits to messenger redeploys, and container custom domains
  are CNAME-only too (same apex problem). Rejected.
- **A separate repository** — cleaner isolation, but loses the atomic
  cross-cutting edit (download links + product copy moving together) and
  fragments the documentation-first surface. Rejected.
- **Reuse the Vite/React app stack** — stack uniformity, but a client runtime on
  a static brochure with no interactivity to justify it. Rejected.
