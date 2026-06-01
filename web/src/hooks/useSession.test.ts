// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/auth';

vi.mock('@/lib/api', () => ({
    deleteDevice: vi.fn().mockResolvedValue(undefined),
    onAuthEvent: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock('@/lib/auth', () => ({
    loadSession: vi.fn().mockResolvedValue(null),
    clearSession: vi.fn().mockResolvedValue(undefined),
    clearToken: vi.fn(),
}));

vi.mock('@/lib/contact-backup', () => ({
    restoreContacts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/key-backup', () => ({
    restoreSessionKeys: vi.fn().mockResolvedValue({ restored: 0, failed: 0 }),
    backupSessionKey: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/wasm', () => ({
    loadWasm: vi.fn().mockResolvedValue({}),
}));

vi.mock('@/lib/megolm-session', () => ({
    createSessionManager: vi.fn().mockResolvedValue({ destroy: vi.fn() }),
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

describe('useSession', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('calls loadSession on mount and exposes result; loading flips to false', async () => {
        const { loadSession } = await import('@/lib/auth');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        expect(result.current.loading).toBe(true);

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(loadSession).toHaveBeenCalledOnce();
        expect(result.current.loading).toBe(false);
        expect(result.current.session).toEqual(fakeSession);
    });

    it('handleLogin sets the session', async () => {
        const { loadSession } = await import('@/lib/auth');
        vi.mocked(loadSession).mockResolvedValue(null);

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(result.current.session).toBeNull();

        act(() => {
            result.current.handleLogin(fakeSession);
        });

        expect(result.current.session).toEqual(fakeSession);
    });

    it('handleLogout calls deleteDevice once then clearSession', async () => {
        const { loadSession, clearSession } = await import('@/lib/auth');
        const { deleteDevice } = await import('@/lib/api');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        await act(async () => {
            await result.current.handleLogout();
        });

        expect(deleteDevice).toHaveBeenCalledOnce();
        expect(clearSession).toHaveBeenCalledOnce();
        expect(result.current.session).toBeNull();
    });

    it('device_revoked auth event triggers logout teardown', async () => {
        const { loadSession, clearSession } = await import('@/lib/auth');
        const { onAuthEvent, deleteDevice } = await import('@/lib/api');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);

        const { useSession } = await import('./useSession');
        renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        // Find the 'device_revoked' callback
        const deviceRevokedCb = vi
            .mocked(onAuthEvent)
            .mock.calls.find(([type]) => type === 'device_revoked')?.[1];
        expect(deviceRevokedCb).toBeDefined();

        await act(async () => {
            if (deviceRevokedCb)
                await (deviceRevokedCb as () => Promise<void>)();
        });

        expect(deleteDevice).toHaveBeenCalled();
        expect(clearSession).toHaveBeenCalled();
    });

    it('unauthorized auth event clears session and calls clearToken', async () => {
        const { loadSession, clearToken } = await import('@/lib/auth');
        const { onAuthEvent } = await import('@/lib/api');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        const unauthorizedCb = vi
            .mocked(onAuthEvent)
            .mock.calls.find(([type]) => type === 'unauthorized')?.[1];
        expect(unauthorizedCb).toBeDefined();

        await act(async () => {
            if (unauthorizedCb) await (unauthorizedCb as () => Promise<void>)();
        });

        expect(clearToken).toHaveBeenCalled();
        expect(result.current.session).toBeNull();
    });

    it('key_version_stale auth event clears session, wipes IDB, sets notice', async () => {
        const { loadSession, clearSession } = await import('@/lib/auth');
        const { onAuthEvent } = await import('@/lib/api');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        const staleCb = vi
            .mocked(onAuthEvent)
            .mock.calls.find(([type]) => type === 'key_version_stale')?.[1];
        expect(staleCb).toBeDefined();

        await act(async () => {
            if (staleCb) await (staleCb as () => Promise<void>)();
        });

        // Full wipe (not clearToken): post-rotation IDB state is encrypted
        // under a key the server no longer accepts; keeping it around buys
        // nothing.
        expect(clearSession).toHaveBeenCalled();
        expect(result.current.session).toBeNull();
        expect(result.current.notice).toBe('rotated_elsewhere');
    });

    it('handleAccountDeleted clears session, wipes IDB, sets account_deleted notice', async () => {
        const { loadSession, clearSession } = await import('@/lib/auth');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        await act(async () => {
            await result.current.handleAccountDeleted();
        });

        expect(clearSession).toHaveBeenCalled();
        expect(result.current.session).toBeNull();
        expect(result.current.notice).toBe('account_deleted');
    });

    it('clearNotice clears the account_deleted notice', async () => {
        const { loadSession } = await import('@/lib/auth');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });
        await act(async () => {
            await result.current.handleAccountDeleted();
        });
        expect(result.current.notice).toBe('account_deleted');

        act(() => {
            result.current.clearNotice();
        });
        expect(result.current.notice).toBeNull();
    });

    it('handleLogin clears any pending notice', async () => {
        const { loadSession } = await import('@/lib/auth');
        const { onAuthEvent } = await import('@/lib/api');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        const staleCb = vi
            .mocked(onAuthEvent)
            .mock.calls.find(([type]) => type === 'key_version_stale')?.[1];
        await act(async () => {
            if (staleCb) await (staleCb as () => Promise<void>)();
        });
        expect(result.current.notice).toBe('rotated_elsewhere');

        act(() => {
            result.current.handleLogin(fakeSession);
        });
        expect(result.current.notice).toBeNull();
    });

    it('clearNotice clears the notice explicitly', async () => {
        const { loadSession } = await import('@/lib/auth');
        const { onAuthEvent } = await import('@/lib/api');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        const staleCb = vi
            .mocked(onAuthEvent)
            .mock.calls.find(([type]) => type === 'key_version_stale')?.[1];
        await act(async () => {
            if (staleCb) await (staleCb as () => Promise<void>)();
        });
        expect(result.current.notice).toBe('rotated_elsewhere');

        act(() => {
            result.current.clearNotice();
        });
        expect(result.current.notice).toBeNull();
    });

    it('unmount removes onAuthEvent listeners', async () => {
        const { loadSession } = await import('@/lib/auth');
        const { onAuthEvent } = await import('@/lib/api');
        vi.mocked(loadSession).mockResolvedValue(null);

        const unsub = vi.fn();
        vi.mocked(onAuthEvent).mockReturnValue(unsub);

        const { useSession } = await import('./useSession');
        const { unmount } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        unmount();

        // All three unsubscribe functions should have been called
        // (device_revoked, unauthorized, key_version_stale).
        expect(unsub).toHaveBeenCalledTimes(3);
    });

    it('StrictMode double-mount does not set sessionManager concurrently', async () => {
        const React = await import('react');
        const { loadSession } = await import('@/lib/auth');
        const { createSessionManager } = await import('@/lib/megolm-session');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession(), {
            wrapper: ({ children }) =>
                React.createElement(React.StrictMode, null, children),
        });

        await act(async () => {
            await new Promise((r) => setTimeout(r, 10));
        });

        // createSessionManager may be called once or twice (once per mount in
        // StrictMode), but the cancelled flag ensures only the second mount's
        // result reaches state. sessionManager should not be null.
        expect(createSessionManager).toHaveBeenCalled();
        expect(result.current.sessionManager).not.toBeNull();
    });

    it('surfaces restoreWarning when restore reports failures, clearable', async () => {
        const { loadSession } = await import('@/lib/auth');
        const { restoreSessionKeys } = await import('@/lib/key-backup');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);
        vi.mocked(restoreSessionKeys).mockResolvedValue({
            restored: 2,
            failed: 3,
        });

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 10));
        });

        expect(result.current.restoreWarning).toBe(3);

        act(() => {
            result.current.clearRestoreWarning();
        });
        expect(result.current.restoreWarning).toBeNull();
    });

    it('no restoreWarning when restore reports zero failures', async () => {
        const { loadSession } = await import('@/lib/auth');
        const { restoreSessionKeys } = await import('@/lib/key-backup');
        vi.mocked(loadSession).mockResolvedValue(fakeSession);
        vi.mocked(restoreSessionKeys).mockResolvedValue({
            restored: 5,
            failed: 0,
        });

        const { useSession } = await import('./useSession');
        const { result } = renderHook(() => useSession());

        await act(async () => {
            await new Promise((r) => setTimeout(r, 10));
        });

        expect(result.current.restoreWarning).toBeNull();
    });
});
