# Pivot the marketing site from Scaleway to GitHub Pages

> Decided: drop Scaleway as the marketing-site host, use GitHub Pages. Edge
> Services can't serve the bare apex (subdomain-only) — that's the deal-breaker,
> and DNS still isn't working. It's just marketing. **Pragmatism beats purity**
> — a principle to encode in the Zen of atmin.

## Current

- [site/](../site/) (Astro) builds static `dist/` — unchanged, keep it.
- Deploy is [.github/workflows/site.yml](../.github/workflows/site.yml):
  `s3cmd sync` to the Scaleway `atmin-site` bucket behind Edge Services (the
  now-overwritten Scaleway version of
  [ADR-0025](../docs/decisions/adr-0025-marketing-site.md)). `www.atmin.net`
  CNAMEs to the Edge endpoint; cert was still pending.
- A precedent already exists: the `deploy-storybook` job in
  [deploy.yml](../.github/workflows/deploy.yml) publishes
  `storybook.atmin.net` to GitHub Pages (external repo + CNAME) via
  `peaceiris/actions-gh-pages`.

## Change

1. **ADR-0025 — done** (overwritten to the GitHub Pages decision). It was
   accepted on optimism, never deployed, never relied upon, so it was rewritten
   in place rather than ceremonially superseded (the
   [ADR README](../docs/decisions/README.md) narrow overwrite exception). The
   remaining steps are the implementation pivot.
2. **Replace `site.yml`** with a GH-Pages deploy (mirror `deploy-storybook`):
   build `site/`, publish `dist/`, set the custom-domain CNAME. Apex works here.
3. **DNS** (Scaleway DNS stays the zone host): apex `atmin.net` → GitHub Pages
   `A` (`185.199.108–111.153`) + `AAAA` (`2606:50c0:8000–8003::153`); `www`
   `CNAME` → `<user>.github.io` (**not** the apex — GitHub's docs warn that
   breaks Enforce-HTTPS). GH auto-provisions the cert for apex + www (up to 24h).
4. **`astro.config.mjs`** `site` → `https://atmin.net` again (apex is canonical
   once more — GH Pages does apex).
5. **Decommission Scaleway site infra**: delete the Edge pipeline + the
   `atmin-site` bucket + the `www`→Edge CNAME. Rewrite [docs/ops.md](../docs/ops.md)
   "Marketing site" for GH Pages (drop the s3cmd / Edge / bucket setup); update
   [CONTRIBUTING.md](../CONTRIBUTING.md) if it names the host.
6. **Zen of atmin** ([README.md](../README.md)): add the principle. Proposed
   wording to match the existing "_X_ is better than _Y_" cadence: **"Pragmatic
   is better than pure."** — confirm exact phrasing (it's the project's voice).

## Verify

- Push → GH Pages builds & deploys; both `https://atmin.net` and
  `https://www.atmin.net` load with a valid cert; canonical/OG = apex.
- ADR-0025 reads as the GitHub Pages decision; ops.md/CONTRIBUTING describe GH
  Pages, no stale Scaleway-site instructions.
- Scaleway Edge pipeline + bucket removed (no orphaned, paid-for resources).
