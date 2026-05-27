/**
 * Main-thread client for the Argon2id worker.
 *
 * `argonStretch` spawns the worker on first use, reuses it for
 * subsequent calls, and terminates it after a short idle so the 64 MiB
 * Argon2id arena is not pinned for the life of the tab. Requests are
 * correlated by id so overlapping calls (rare, but possible if a user
 * retries) don't cross their results.
 */

import type { Argon2Request, Argon2Response } from './argon2-worker';
import type { KdfParams } from './crypto';

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
 * Stretch a UTF-8 password into a 16-byte secret via Argon2id in a
 * worker. Resolves with the secret or rejects with the worker error.
 */
export function argonStretch(
    password: string,
    salt: Uint8Array,
    kdf: KdfParams,
): Promise<Uint8Array> {
    const w = getWorker();
    const id = nextId++;
    const passwordBytes = new TextEncoder().encode(password);

    return new Promise<Uint8Array>((resolve, reject) => {
        const onMessage = (e: MessageEvent<Argon2Response>) => {
            if (e.data.id !== id) return;
            w.removeEventListener('message', onMessage);
            scheduleShutdown();
            if (e.data.ok) resolve(e.data.secret);
            else reject(new Error(e.data.error));
        };
        w.addEventListener('message', onMessage);
        const req: Argon2Request = { id, password: passwordBytes, salt, kdf };
        w.postMessage(req);
    });
}
