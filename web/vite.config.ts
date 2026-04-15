/// <reference types="vitest/config" />
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vitest/config';
import type { IncomingMessage } from 'node:http';

type ReqWithBody = IncomingMessage & { _rawBody?: Buffer };

// WKWebView on iOS streams the POST body in a way that http-proxy doesn't
// buffer before forwarding, so the body arrives empty at the target server.
// This plugin consumes the body first; the proxyReq handler below replays it.
function bufferProxyBodies(): Plugin {
    return {
        name: 'buffer-proxy-bodies',
        configureServer(server) {
            server.middlewares.use('/v1', (req: ReqWithBody, _res, next) => {
                if (req.method === 'GET' || req.method === 'HEAD') return next();
                const chunks: Buffer[] = [];
                req.on('data', (c: Buffer) => chunks.push(c));
                req.on('end', () => {
                    req._rawBody = Buffer.concat(chunks);
                    next();
                });
            });
        },
    };
}

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
    plugins: [react(), tailwindcss(), bufferProxyBodies()],
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
            '/v1': {
                target: apiUrl,
                // Replay the body buffered by the bufferProxyBodies plugin.
                // By this point req stream is already consumed; we write the
                // buffer directly so http-proxy's pipe sees an empty stream.
                configure: (proxy) => {
                    proxy.on('proxyReq', (proxyReq, req: ReqWithBody) => {
                        const body = req._rawBody;
                        if (body?.length) {
                            proxyReq.setHeader('Content-Length', body.length);
                            proxyReq.write(body);
                        }
                    });
                },
            },
            '/healthz': apiUrl,
        },
    },
});
