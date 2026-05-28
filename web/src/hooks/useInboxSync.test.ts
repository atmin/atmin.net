// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/auth';

vi.mock('@/lib/inbox-sync', () => ({
    syncAndPublish: vi.fn().mockResolvedValue(undefined),
}));

const fakeSession: Session = {
    token: 'tok',
    userId: 'user1',
    deviceId: 'dev1',
    handle: 'alice',
    sharingPrivateKey: {} as CryptoKey,
    sharingPublicKeyBytes: new Uint8Array([1, 2, 3]),
    backupKey: {} as CryptoKey,
    keyVersion: 1,
};

const fakeMgr = { destroy: vi.fn() };

// Minimal EventSource fake
class FakeEventSource {
    static instances: FakeEventSource[] = [];
    url: string;
    onerror: ((e: Event) => void) | null = null;
    closed = false;
    private listeners = new Map<string, Array<(e: Event) => void>>();

    constructor(url: string) {
        this.url = url;
        FakeEventSource.instances.push(this);
    }

    addEventListener(type: string, fn: (e: Event) => void) {
        if (!this.listeners.has(type)) this.listeners.set(type, []);
        this.listeners.get(type)?.push(fn);
    }

    close() {
        this.closed = true;
    }

    emit(type: string) {
        for (const fn of this.listeners.get(type) ?? []) fn(new Event(type));
    }
}

describe('useInboxSync', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        FakeEventSource.instances = [];
        vi.stubGlobal('EventSource', FakeEventSource);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('calls syncAndPublish once immediately on mount', async () => {
        const { syncAndPublish } = await import('@/lib/inbox-sync');
        const { useInboxSync } = await import('./useInboxSync');

        renderHook(() => useInboxSync(fakeSession, fakeMgr as never));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(syncAndPublish).toHaveBeenCalledOnce();
        expect(syncAndPublish).toHaveBeenCalledWith(fakeSession, fakeMgr);
    });

    it('a new_message SSE event triggers a second syncAndPublish call', async () => {
        const { syncAndPublish } = await import('@/lib/inbox-sync');
        const { useInboxSync } = await import('./useInboxSync');

        renderHook(() => useInboxSync(fakeSession, fakeMgr as never));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(FakeEventSource.instances).toHaveLength(1);
        const es = FakeEventSource.instances[0];

        await act(async () => {
            es.emit('new_message');
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(syncAndPublish).toHaveBeenCalledTimes(2);
    });

    it('unmount closes the EventSource', async () => {
        const { useInboxSync } = await import('./useInboxSync');

        const { unmount } = renderHook(() =>
            useInboxSync(fakeSession, fakeMgr as never),
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        const es = FakeEventSource.instances[0];
        expect(es.closed).toBe(false);

        unmount();

        expect(es.closed).toBe(true);
    });

    it('does nothing when session or sessionManager is null', async () => {
        const { syncAndPublish } = await import('@/lib/inbox-sync');
        const { useInboxSync } = await import('./useInboxSync');

        renderHook(() => useInboxSync(null, null));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(syncAndPublish).not.toHaveBeenCalled();
        expect(FakeEventSource.instances).toHaveLength(0);
    });

    it('does not open EventSource while offline; reconnects when back online', async () => {
        const onLineSpy = vi
            .spyOn(navigator, 'onLine', 'get')
            .mockReturnValue(false);
        try {
            const { syncAndPublish } = await import('@/lib/inbox-sync');
            const { useInboxSync } = await import('./useInboxSync');

            renderHook(() => useInboxSync(fakeSession, fakeMgr as never));

            await act(async () => {
                await new Promise((r) => setTimeout(r, 0));
            });

            expect(syncAndPublish).not.toHaveBeenCalled();
            expect(FakeEventSource.instances).toHaveLength(0);

            // Flip the spy back to true and fire the event so the hook
            // re-runs its effect with online=true.
            onLineSpy.mockReturnValue(true);
            await act(async () => {
                window.dispatchEvent(new Event('online'));
                await new Promise((r) => setTimeout(r, 0));
            });

            expect(syncAndPublish).toHaveBeenCalledOnce();
            expect(FakeEventSource.instances).toHaveLength(1);
        } finally {
            onLineSpy.mockRestore();
        }
    });

    it('closes EventSource and skips reopening when going offline', async () => {
        const { useInboxSync } = await import('./useInboxSync');

        renderHook(() => useInboxSync(fakeSession, fakeMgr as never));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(FakeEventSource.instances).toHaveLength(1);
        const es = FakeEventSource.instances[0];

        await act(async () => {
            window.dispatchEvent(new Event('offline'));
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(es.closed).toBe(true);
        expect(FakeEventSource.instances).toHaveLength(1);
    });
});
