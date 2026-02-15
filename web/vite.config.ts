import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import { defineConfig } from 'vitest/config';

const apiUrl = process.env.VITE_API_URL || 'http://localhost:8080';

export default defineConfig({
    plugins: [react(), tailwindcss()],
    test: {
        exclude: ['e2e/**', 'node_modules/**'],
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
        },
    },
    server: {
        proxy: {
            '/v1': apiUrl,
            '/healthz': apiUrl,
        },
    },
});
