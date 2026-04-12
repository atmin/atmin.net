/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { execSync } from 'node:child_process';
import { defineConfig } from 'vitest/config';

const gitVersion = (() => {
    if (process.env.APP_VERSION) return process.env.APP_VERSION;
    try {
        return execSync('git describe --tags --always --dirty', {
            encoding: 'utf8',
        }).trim();
    } catch {
        return 'dev';
    }
})();

const dirname =
    typeof __dirname !== 'undefined'
        ? __dirname
        : path.dirname(fileURLToPath(import.meta.url));
const apiUrl = process.env.VITE_API_URL || 'http://localhost:8080';

export default defineConfig({
    plugins: [react(), tailwindcss()],
    define: {
        __APP_VERSION__: JSON.stringify(gitVersion),
    },
    test: {
        exclude: ['e2e/**', 'node_modules/**'],
        projects: [
            // Unit tests (default)
            {
                extends: true,
                test: {
                    name: 'unit',
                    include: ['src/**/*.test.ts'],
                    exclude: ['e2e/**', 'node_modules/**'],
                },
            },
            // Storybook interaction tests
            {
                extends: true,
                plugins: [
                    storybookTest({
                        configDir: path.join(dirname, '.storybook'),
                    }),
                ],
                test: {
                    name: 'storybook',
                    browser: {
                        enabled: true,
                        headless: true,
                        provider: 'playwright',
                        instances: [{ browser: 'chromium' }],
                    },
                    setupFiles: ['.storybook/vitest.setup.ts'],
                },
            },
        ],
    },
    resolve: {
        alias: {
            '@': path.resolve(dirname, './src'),
        },
    },
    server: {
        proxy: {
            '/v1': apiUrl,
            '/healthz': apiUrl,
        },
    },
});
