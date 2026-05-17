import { defineConfig, devices } from '@playwright/test';

const APP_PORT = 8080;
const E2E_BUCKET = process.env.E2E_BUCKET || `atmin-e2e-${Date.now()}`;

process.env.E2E_BUCKET = E2E_BUCKET;

export default defineConfig({
    testDir: './e2e',
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: 1,
    reporter: 'html',
    timeout: 60_000,

    globalSetup: './e2e-global-setup.ts',
    globalTeardown: './e2e-global-teardown.ts',

    use: {
        baseURL: `http://localhost:${APP_PORT}`,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        video: 'retain-on-failure',
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],
});
