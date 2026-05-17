// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/auth';

vi.mock('@/lib/api', () => ({
    storeGet: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
}));

vi.mock('@/lib/contact-backup', () => ({
    uploadContacts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/db', () => ({
    loadConversations: vi.fn().mockResolvedValue([]),
    loadAllContacts: vi.fn().mockResolvedValue(new Map()),
    saveContact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/inbox-sync', () => ({
    onInboxUpdated: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock('@/lib/paths', () => ({
    path: {
        profile: vi
            .fn()
            .mockImplementation((uid: string) => `users/${uid}/profile.json`),
    },
}));

const fakeSession: Session = {
    token: 'tok',
    userId: 'user1',
    deviceId: 'dev1',
    handle: 'alice',
    sharingPrivateKey: {} as CryptoKey,
    sharingPublicKeyBytes: new Uint8Array([1, 2, 3]),
    backupKey: {} as CryptoKey,
};

const fakeMgr = { destroy: vi.fn() };

describe('useConversations', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('renders cached conversations from IDB immediately', async () => {
        const { loadConversations } = await import('@/lib/db');
        vi.mocked(loadConversations).mockResolvedValue([
            {
                conversationId: 'self:user1',
                lastMessageText: 'hi',
                lastMessageTimestamp: Date.now(),
                messageCount: 1,
            },
        ]);

        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', mockFetch);

        const { useConversations } = await import('./useConversations');
        const { result } = renderHook(() =>
            useConversations(fakeSession, fakeMgr as never),
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(loadConversations).toHaveBeenCalled();
        expect(result.current.conversations).toHaveLength(1);
        expect(result.current.conversations[0].conversationId).toBe(
            'self:user1',
        );
    });

    it('serverOk flips to true after /healthz resolves with ok:true', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', mockFetch);

        const { useConversations } = await import('./useConversations');
        const { result } = renderHook(() =>
            useConversations(fakeSession, fakeMgr as never),
        );

        expect(result.current.serverOk).toBeNull();

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(mockFetch).toHaveBeenCalledWith('/healthz');
        expect(result.current.serverOk).toBe(true);
    });

    it('serverOk is false when /healthz returns ok:false', async () => {
        const mockFetch = vi.fn().mockResolvedValue({ ok: false });
        vi.stubGlobal('fetch', mockFetch);

        const { useConversations } = await import('./useConversations');
        const { result } = renderHook(() =>
            useConversations(fakeSession, fakeMgr as never),
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(result.current.serverOk).toBe(false);
    });

    it('serverOk is false when fetch throws', async () => {
        const mockFetch = vi.fn().mockRejectedValue(new Error('offline'));
        vi.stubGlobal('fetch', mockFetch);

        const { useConversations } = await import('./useConversations');
        const { result } = renderHook(() =>
            useConversations(fakeSession, fakeMgr as never),
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(result.current.serverOk).toBe(false);
    });

    it('does not load conversations when sessionManager is null', async () => {
        const { loadConversations } = await import('@/lib/db');
        const mockFetch = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', mockFetch);

        const { useConversations } = await import('./useConversations');
        renderHook(() => useConversations(fakeSession, null));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(loadConversations).not.toHaveBeenCalled();
    });
});
