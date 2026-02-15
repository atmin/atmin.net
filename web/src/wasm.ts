/**
 * Environment-aware WASM loader.
 * - Browser: dynamic import of web target + init()
 * - Node/test: import of nodejs target (auto-inits)
 */

import type { MegolmInbound, MegolmOutbound } from '../crypto/pkg/atmin_crypto';

export interface WasmModule {
    MegolmOutbound: typeof MegolmOutbound;
    MegolmInbound: typeof MegolmInbound;
}

let cached: WasmModule | null = null;

export async function loadWasm(): Promise<WasmModule> {
    if (cached) return cached;

    // biome-ignore lint/suspicious/noExplicitAny: runtime node detection
    const g = globalThis as any;
    if (g.process?.versions?.node) {
        // Node.js / vitest — pkg-node auto-inits
        const mod = await import('../crypto/pkg-node/atmin_crypto.js');
        cached = mod as unknown as WasmModule;
    } else {
        // Browser — web target needs init()
        const mod = await import('../crypto/pkg/atmin_crypto.js');
        await mod.default();
        cached = mod as unknown as WasmModule;
    }

    return cached;
}
