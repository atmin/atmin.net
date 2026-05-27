// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KdfParams } from './crypto';

// Mock the worker — this test exercises the main-thread client
// (argonStretch): the request/response wire shape and error
// propagation. The real algorithm is covered by argon2-wasm.test.ts.
class MockWorker {
    static instances: MockWorker[] = [];
    listeners: Array<(e: { data: unknown }) => void> = [];
    posted: unknown[] = [];
    terminated = false;

    constructor(
        public url: string | URL,
        public opts: unknown,
    ) {
        MockWorker.instances.push(this);
    }

    addEventListener(type: string, cb: (e: { data: unknown }) => void) {
        if (type === 'message') this.listeners.push(cb);
    }
    removeEventListener(type: string, cb: (e: { data: unknown }) => void) {
        if (type === 'message')
            this.listeners = this.listeners.filter((l) => l !== cb);
    }
    postMessage(msg: unknown) {
        this.posted.push(msg);
    }
    terminate() {
        this.terminated = true;
    }

    respond(data: unknown) {
        for (const l of [...this.listeners]) l({ data });
    }
}

const kdf: KdfParams = { type: 'argon2id', m: 8, t: 1, p: 1 };
const salt = new Uint8Array(16).fill(3);

describe('argonStretch (worker client)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.resetModules();
        MockWorker.instances = [];
        vi.stubGlobal('Worker', MockWorker as unknown as typeof Worker);
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('posts {id, password, salt, kdf} and resolves with the returned secret', async () => {
        const { argonStretch } = await import('./argon2-worker.client');
        const promise = argonStretch('hunter2', salt, kdf);

        expect(MockWorker.instances).toHaveLength(1);
        const worker = MockWorker.instances[0];
        expect(worker.posted).toHaveLength(1);

        const req = worker.posted[0] as {
            id: number;
            password: Uint8Array;
            salt: Uint8Array;
            kdf: KdfParams;
        };
        expect(typeof req.id).toBe('number');
        expect(req.password).toEqual(new TextEncoder().encode('hunter2'));
        expect(req.salt).toEqual(salt);
        expect(req.kdf).toEqual(kdf);

        const secret = new Uint8Array(16).fill(9);
        worker.respond({ id: req.id, ok: true, secret });

        await expect(promise).resolves.toEqual(secret);
    });

    it('propagates a worker error as a rejection', async () => {
        const { argonStretch } = await import('./argon2-worker.client');
        const promise = argonStretch('pw', salt, kdf);
        const worker = MockWorker.instances[0];
        const { id } = worker.posted[0] as { id: number };

        worker.respond({ id, ok: false, error: 'argon2 derivation failed' });

        await expect(promise).rejects.toThrow('argon2 derivation failed');
    });

    it('ignores responses with a mismatched id', async () => {
        const { argonStretch } = await import('./argon2-worker.client');
        const promise = argonStretch('pw', salt, kdf);
        const worker = MockWorker.instances[0];
        const { id } = worker.posted[0] as { id: number };

        // A stale message for a different request must not resolve this one.
        worker.respond({ id: id + 999, ok: true, secret: new Uint8Array(16) });
        const settled = vi.fn();
        promise.then(settled, settled);
        await Promise.resolve();
        expect(settled).not.toHaveBeenCalled();

        worker.respond({ id, ok: true, secret: new Uint8Array(16).fill(1) });
        await expect(promise).resolves.toEqual(new Uint8Array(16).fill(1));
    });

    it('terminates the idle worker after the shutdown delay', async () => {
        const { argonStretch } = await import('./argon2-worker.client');
        const promise = argonStretch('pw', salt, kdf);
        const worker = MockWorker.instances[0];
        const { id } = worker.posted[0] as { id: number };
        worker.respond({ id, ok: true, secret: new Uint8Array(16) });
        await promise;

        expect(worker.terminated).toBe(false);
        vi.advanceTimersByTime(10_000);
        expect(worker.terminated).toBe(true);
    });
});
