import { defineConfig, devices } from '@playwright/test';

const GO_PORT = 8081;
const VITE_PORT = 5174;
const E2E_BUCKET = `atmin-e2e-${Date.now()}`;

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
        baseURL: `http://localhost:${VITE_PORT}`,
        trace: 'on-first-retry',
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],

    webServer: [
        {
            command: 'cd ../server && go run .',
            port: GO_PORT,
            reuseExistingServer: false,
            timeout: 30_000,
            env: {
                PATH: process.env.PATH || '',
                HOME: process.env.HOME || '',
                GOPATH: process.env.GOPATH || '',
                LISTEN_ADDR: `:${GO_PORT}`,
                SERVER_SECRET: 'e2e-test-secret',
                S3_ENDPOINT: 'http://localhost:9000',
                S3_BUCKET: E2E_BUCKET,
                S3_REGION: 'us-east-1',
                S3_ACCESS_KEY: 'minioadmin',
                S3_SECRET_KEY: 'minioadmin',
            },
        },
        {
            command: `npx vite --port ${VITE_PORT}`,
            port: VITE_PORT,
            reuseExistingServer: false,
            timeout: 15_000,
            env: {
                ...process.env,
                VITE_API_URL: `http://localhost:${GO_PORT}`,
            },
        },
    ],
});
