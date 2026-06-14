/**
 * Main-thread client for the Argon2id worker.
 *
 * `argonStretch` spawns the worker on first use, reuses it for
 * subsequent calls, and terminates it after a short idle so the 64 MiB
 * Argon2id arena is not pinned for the life of the tab. Requests are
 * correlated by id so overlapping calls (rare, but possible if a user
 * retries) don't cross their results.
 */

import type { PowChallenge } from './api';
import type { Argon2Request, Argon2Response } from './argon2-worker';
import { base64UrlDecode, type KdfParams } from './crypto';

const IDLE_SHUTDOWN_MS = 10_000;

let worker: Worker | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let nextId = 0;

function getWorker(): Worker {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    if (!worker) {
        worker = new Worker(new URL('./argon2-worker.ts', import.meta.url), {
            type: 'module',
        });
    }
    return worker;
}

function scheduleShutdown(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
        worker?.terminate();
        worker = null;
        idleTimer = null;
    }, IDLE_SHUTDOWN_MS);
}

/**
 * Post a job to the worker and resolve with its success response, correlated by
 * `id`. Rejects on a worker error. The caller picks `secret` / `counter` off the
 * resolved response.
 */
function runWorker(
    req: Argon2Request,
): Promise<Extract<Argon2Response, { ok: true }>> {
    const w = getWorker();
    return new Promise((resolve, reject) => {
        const onMessage = (e: MessageEvent<Argon2Response>) => {
            if (e.data.id !== req.id) return;
            w.removeEventListener('message', onMessage);
            scheduleShutdown();
            if (e.data.ok) resolve(e.data);
            else reject(new Error(e.data.error));
        };
        w.addEventListener('message', onMessage);
        w.postMessage(req);
    });
}

/**
 * Stretch a UTF-8 password into a 16-byte secret via Argon2id in a
 * worker. Resolves with the secret or rejects with the worker error.
 */
export async function argonStretch(
    password: string,
    salt: Uint8Array,
    kdf: KdfParams,
): Promise<Uint8Array> {
    const passwordBytes = new TextEncoder().encode(password);
    const res = await runWorker({
        id: nextId++,
        kind: 'derive',
        password: passwordBytes,
        salt,
        kdf,
    });
    if (!('secret' in res)) throw new Error('unexpected worker response');
    return res.secret;
}

/**
 * Solve a registration proof-of-work challenge (ADR-0020) in the worker.
 * Resolves with the counter satisfying the issued difficulty; `bits === 0`
 * resolves with 0 immediately.
 */
export async function solvePow(challenge: PowChallenge): Promise<number> {
    const res = await runWorker({
        id: nextId++,
        kind: 'pow',
        nonce: base64UrlDecode(challenge.nonce),
        m: challenge.m,
        t: challenge.t,
        p: challenge.p,
        bits: challenge.bits,
    });
    if (!('counter' in res)) throw new Error('unexpected worker response');
    return res.counter;
}
