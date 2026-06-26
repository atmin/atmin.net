// @ts-check
import { defineConfig } from 'astro/config';
import tailwindcss from '@tailwindcss/vite';

// Static brochure for the apex (ADR-0025). `site` drives canonical/OG URLs and
// is the production origin; the build output (dist/) is published to GitHub
// Pages at the bare apex by .github/workflows/site.yml.
export default defineConfig({
    site: 'https://atmin.net',
    vite: {
        plugins: [tailwindcss()],
    },
});
