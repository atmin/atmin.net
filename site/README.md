# site/

The public-facing marketing site at the apex, `atmin.net` — the front door that
links out to the web app (`app.atmin.net`) and, later, the app-store and desktop
builds. Static brochureware: no backend, no user data.

Astro + Tailwind v4, static output. Rationale and the hosting decision live in
[ADR-0025](../docs/decisions/adr-0025-marketing-site.md); the deploy pipeline and
one-time Scaleway setup are in [ops.md](../docs/ops.md) "Marketing site".

## Develop

```sh
make site-dev      # astro dev server (or: cd site && pnpm dev)
make site-build    # astro check + static build → site/dist
make site-check    # type-check only
```

`make install` installs these deps alongside `web/`'s.

## Deploy

Automatic: pushing to `master` with changes under `site/**` triggers
[.github/workflows/site.yml](../.github/workflows/site.yml), which builds and
`s3cmd sync`s `dist/` to the Scaleway public bucket behind Edge Services. No tag
ceremony — a brochure has no e2e gate.

## Structure

```
src/
  layouts/Base.astro      <head>, meta/OG, the shared shell
  components/Logo.astro    brand mark (path shared with web/)
  pages/index.astro        the landing page
  styles/global.css        Tailwind v4 + the app's token palette
public/favicon.svg         brand mark (OS-themed), copied from web/
```

The token palette mirrors `web/src/index.css` so the brochure and the app read
as one product. Light/dark is OS-driven (`prefers-color-scheme`) — no toggle.
