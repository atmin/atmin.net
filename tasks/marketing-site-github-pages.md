# Marketing site on GitHub Pages — go-live

> Pivot from Scaleway → GitHub Pages (apex + free TLS; Edge is subdomain-only,
> the deal-breaker). **Repo side done; manual go-live + decommission remain.**
> Delete this file once `https://atmin.net` is live with a valid cert.

## Done (repo)

- [ADR-0025](../docs/decisions/adr-0025-marketing-site.md) is the GitHub Pages
  decision (overwritten earlier — accepted on optimism, never deployed).
- [site.yml](../.github/workflows/site.yml): builds `site/` → publishes `dist/`
  to this repo's `gh-pages` branch via `peaceiris/actions-gh-pages`, `cname:
  atmin.net`, default `GITHUB_TOKEN` (same-repo, no PAT).
- [astro.config.mjs](../site/astro.config.mjs) `site` = `https://atmin.net`.
- [ops.md](../docs/ops.md) "Marketing site" rewritten for GitHub Pages (setup +
  DNS records + Scaleway decommission); [CONTRIBUTING.md](../CONTRIBUTING.md)
  host reference updated.
- "Pragmatic is better than pure." added to the Zen of atmin
  ([README.md](../README.md)).

## Remaining (manual — console / DNS, see ops.md "Marketing site")

1. Push so `site.yml` runs once and creates `gh-pages`; then repo → Settings →
   Pages: source = `gh-pages` / root, custom domain `atmin.net`, Enforce HTTPS
   (cert up to 24h).
2. DNS (Scaleway zone): apex `A` ×4 + `AAAA` ×4 → GitHub; `www` `CNAME` →
   `atmin.github.io.` (**not** the apex).
3. Decommission Scaleway: delete the Edge Services pipeline + `atmin-site`
   bucket + any `www`→Edge CNAME; drop the `SCW_SITE_EDGE_PIPELINE_ID` secret.

## Verify (then delete this file)

- `https://atmin.net` **and** `https://www.atmin.net` load with a valid cert;
  canonical/OG = apex.
- No orphaned (paid-for) Scaleway site resources remain.
