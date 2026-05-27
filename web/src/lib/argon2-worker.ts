/**
 * Argon2id derivation worker.
 *
 * Runs the memory-hard stretch off the main thread (ADR-0011): a ~3-4s
 * synchronous WASM call would freeze the strength-meter UI and any
 * derivation-time animation. Receives {id, password, salt, kdf}, posts
 * back {id, ok, secret} or {id, ok, error}. The worker holds no
 * long-lived state — the WASM module is loaded lazily and cached by
 * `loadWasm`.
 */

import type { KdfParams } from './crypto';
import { loadWasm } from './wasm';

export interface Argon2Request {
    id: number;
    password: Uint8Array;
    salt: Uint8Array;
    kdf: KdfParams;
}

export type Argon2Response =
    | { id: number; ok: true; secret: Uint8Array }
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
    const { id, password, salt, kdf } = e.data;
    try {
        const wasm = await loadWasm();
        const secret = wasm.derive_secret(password, salt, kdf.m, kdf.t, kdf.p);
        ctx.postMessage({ id, ok: true, secret });
    } catch (err) {
        ctx.postMessage({
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        });
    }
});
