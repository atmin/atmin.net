# PWA — installable on mobile

## Current state

The app is browser-only. `web/public/` has `logo.svg` and `favicon.svg` but
no manifest. `web/index.html` has no manifest link, no theme-color, and no
Apple-specific meta tags. There is no service worker.

- **iOS Safari**: "Add to Home Screen" works but launches in a browser tab,
  not standalone. No icon is offered; Safari falls back to a screenshot.
- **Android Chrome**: no install prompt appears; installability criteria are
  not met (no manifest, no service worker).

## Approach

Use `vite-plugin-pwa`. It generates the manifest, registers a service worker,
and handles the SW update lifecycle — all from `vite.config.ts`. No manual
SW authoring needed.

The service worker strategy is **network-first for API calls, cache-first for
static assets**. This matches the app's existing behaviour: API calls must
reach the server (or fail gracefully via the offline-mode handling), while
the app shell and WASM binary are large and change only on deploy.

Do not enable SW in development (`mode !== 'development'`) — SW caching
interferes with Vite's HMR.

## Change

### 1. Install dependency

```
cd web && npm install -D vite-plugin-pwa
```

### 2. Generate PNG icons from `logo.svg`

`vite-plugin-pwa` requires raster icons — SVG alone is not sufficient for
iOS or Android home screen icons. Generate two PNGs from `web/public/logo.svg`:

- `web/public/icons/icon-192.png` — 192×192
- `web/public/icons/icon-512.png` — 512×512
- `web/public/icons/apple-touch-icon.png` — 180×180 (iOS specific)

Use any SVG→PNG tool (`sharp`, `Inkscape`, `rsvg-convert`, or an online
converter). The icons should have a solid background colour matching the app's
theme (not transparent — iOS renders transparency as black).

### 3. `web/vite.config.ts` — add plugin

```ts
import { VitePWA } from 'vite-plugin-pwa';

// inside defineConfig plugins array:
VitePWA({
    registerType: 'autoUpdate',
    devOptions: { enabled: false },
    manifest: {
        name: 'atmin',
        short_name: 'atmin',
        description: 'End-to-end encrypted messaging',
        start_url: '/',
        display: 'standalone',
        background_color: '#ffffff',   // match app background
        theme_color: '#ffffff',        // match app theme
        icons: [
            {
                src: '/icons/icon-192.png',
                sizes: '192x192',
                type: 'image/png',
            },
            {
                src: '/icons/icon-512.png',
                sizes: '512x512',
                type: 'image/png',
                purpose: 'any maskable',
            },
        ],
    },
    workbox: {
        // Cache the app shell and static assets (JS, CSS, WASM)
        globPatterns: ['**/*.{js,css,html,wasm,svg,png}'],
        // Network-first for all API routes — never serve stale auth/messages
        runtimeCaching: [
            {
                urlPattern: /^\/v1\//,
                handler: 'NetworkOnly',
            },
        ],
    },
}),
```

`NetworkOnly` for `/v1/` routes means the SW does not interfere with API
calls. Offline behaviour is handled by the app itself (see
`docs/scenarios/offline-mode.md`), not by SW cache.

`purpose: 'any maskable'` on the 512px icon satisfies Android's adaptive
icon requirement. If the logo has significant padding, a separate
`maskable` icon with the subject filling the safe zone (centre 80%) is
preferable — skip for now, revisit if the icon looks wrong on Android.

### 4. `web/index.html` — add meta tags

```html
<meta name="theme-color" content="#ffffff" />
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="default" />
<meta name="apple-mobile-web-app-title" content="atmin" />
```

`vite-plugin-pwa` injects `<link rel="manifest">` automatically into the
built HTML. The Apple meta tags are not injected by the plugin and must be
added manually.

`apple-mobile-web-app-status-bar-style: default` keeps the status bar
light. Change to `black-translucent` if the app header is dark and you want
the status bar to overlay it (requires adjusting safe-area insets).

### 5. Verify colours

Set `background_color` and `theme_color` in the manifest (and
`meta name="theme-color"`) to the actual background colour of the app shell.
Check `tailwind.config` or the root CSS variable — likely `#ffffff` in light
mode. If the app supports dark mode via `prefers-color-scheme`, use the light
value for these fields (they apply at launch before the app renders).

## Verify

- `cd web && npm run build` — build output includes `sw.js`,
  `manifest.webmanifest`, and icon PNGs.
- `cd web && npx vite preview` — serve the production build locally over
  HTTP. Open Chrome DevTools → Application → Manifest: all fields populated,
  no errors. Application → Service Workers: SW registered and active.
- **Android Chrome** (physical device or emulator): open the preview URL,
  wait a moment — Chrome address bar shows an install icon, or
  `⋮ → Add to Home Screen` is available. Installed app opens in standalone
  mode (no browser chrome).
- **iOS Safari** (physical device): open the preview URL, Share →
  Add to Home Screen — the app icon appears (not a screenshot). Installed
  app opens in standalone mode.
- Lighthouse PWA audit (DevTools): passes installability checks.
- Existing e2e tests still pass (`cd web && npx playwright test`) — the SW
  is disabled in dev mode and e2e runs against the dev server, so no
  interference.

## No e2e test

PWA installation is a browser-native gesture that Playwright cannot fully
automate (Chrome's install prompt and iOS's Share sheet are outside the
automation surface). The Lighthouse audit and manual device checks are
the verification path.
