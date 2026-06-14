/**
 * Argon2id worker — runs both memory-hard jobs off the main thread so a
 * multi-second synchronous WASM call never freezes the UI:
 *  - `derive`: credential stretch → 16-byte secret (ADR-0011).
 *  - `pow`: registration proof-of-work search → counter (ADR-0020).
 *
 * Requests are tagged by `kind`; responses are correlated by `id` and carry
 * `secret` (derive) or `counter` (pow). The worker holds no long-lived state —
 * the WASM module is loaded lazily and cached by `loadWasm`.
 */

import type { KdfParams } from './crypto';
import { loadWasm } from './wasm';

export interface DeriveRequest {
    id: number;
    kind: 'derive';
    password: Uint8Array;
    salt: Uint8Array;
    kdf: KdfParams;
}

export interface PowRequest {
    id: number;
    kind: 'pow';
    nonce: Uint8Array;
    m: number;
    t: number;
    p: number;
    bits: number;
}

export type Argon2Request = DeriveRequest | PowRequest;

export type Argon2Response =
    | { id: number; ok: true; secret: Uint8Array }
    | { id: number; ok: true; counter: number }
    | { id: number; ok: false; error: string };

// `self` is the worker global. The DOM lib types it as `Window`, whose
// `postMessage` signature differs from the worker one, so cast through a
// minimal worker-scope shape rather than pulling in the WebWorker lib
// (which collides with DOM in this tsconfig).
const ctx = self as unknown as {
    postMessage(msg: Argon2Response): void;
    addEventListener(
        type: 'message',
        listener: (e: MessageEvent<Argon2Request>) => void,
    ): void;
};

ctx.addEventListener('message', async (e) => {
    const req = e.data;
    try {
        const wasm = await loadWasm();
        if (req.kind === 'pow') {
            // Timing aids PoW calibration (ADR-0020) — attempts ≈ counter + 1.
            const t0 = performance.now();
            const counter = wasm.solve_pow(
                req.nonce,
                req.m,
                req.t,
                req.p,
                req.bits,
            );
            const ms = performance.now() - t0;
            console.info(
                `[pow] bits=${req.bits} m=${req.m} solved counter=${counter} in ${ms.toFixed(0)}ms (~${(ms / (counter + 1)).toFixed(1)}ms/hash)`,
            );
            ctx.postMessage({ id: req.id, ok: true, counter });
        } else {
            const secret = wasm.derive_secret(
                req.password,
                req.salt,
                req.kdf.m,
                req.kdf.t,
                req.kdf.p,
            );
            ctx.postMessage({ id: req.id, ok: true, secret });
        }
    } catch (err) {
        ctx.postMessage({
            id: req.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
