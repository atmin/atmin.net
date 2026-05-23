// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/auth';

vi.mock('@/lib/api', () => ({
    resolve: vi.fn().mockResolvedValue({
        user_id: 'peer-user',
        sharing_public_key: 'peer-key',
    }),
}));

vi.mock('@/lib/contact-backup', () => ({
    uploadContacts: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/crypto', () => ({
    base64UrlDecode: vi.fn().mockReturnValue(new Uint8Array([1, 2, 3])),
}));

vi.mock('@/lib/db', () => ({
    loadMessages: vi.fn().mockResolvedValue([]),
    saveContact: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/inbox-sync', () => ({
    onInboxUpdated: vi.fn().mockReturnValue(vi.fn()),
}));

vi.mock('@/lib/messaging', () => ({
    conversationId: vi.fn().mockReturnValue('self:user1'),
    sendTextMessage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./useChatSend', () => ({
    useChatSend: vi.fn().mockReturnValue({
        sending: false,
        online: true,
        sendText: vi.fn(),
        sendMedia: vi.fn(),
    }),
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

describe('useChat', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('loads cached IDB messages on convId change', async () => {
        const { loadMessages } = await import('@/lib/db');
        vi.mocked(loadMessages).mockResolvedValue([
            {
                id: 'msg1',
                userId: 'user1',
                conversationId: 'self:user1',
                fromUser: 'user1',
                fromDevice: 'dev1',
                text: 'hello',
                timestamp: Date.now(),
            },
        ]);

        const { useChat } = await import('./useChat');
        const { result } = renderHook(() =>
            useChat('saved', fakeSession, fakeMgr as never),
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(loadMessages).toHaveBeenCalledWith('user1');
        expect(result.current.messages).toHaveLength(1);
        expect(result.current.messages[0].text).toBe('hello');
        expect(result.current.loading).toBe(false);
    });

    it('re-reads IDB when inbox update notification fires', async () => {
        const { loadMessages } = await import('@/lib/db');
        const { onInboxUpdated } = await import('@/lib/inbox-sync');
        vi.mocked(loadMessages).mockResolvedValue([]);

        const { useChat } = await import('./useChat');
        renderHook(() => useChat('saved', fakeSession, fakeMgr as never));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        const initialCallCount = vi.mocked(loadMessages).mock.calls.length;

        // Trigger inbox update
        const inboxCb = vi.mocked(onInboxUpdated).mock.calls[0]?.[0];
        await act(async () => {
            inboxCb?.();
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(vi.mocked(loadMessages).mock.calls.length).toBeGreaterThan(
            initialCallCount,
        );
    });

    it('plain text message is not parsed as media', async () => {
        const { loadMessages } = await import('@/lib/db');
        vi.mocked(loadMessages).mockResolvedValue([
            {
                id: 'msg1',
                userId: 'user1',
                conversationId: 'self:user1',
                fromUser: 'user1',
                fromDevice: 'dev1',
                text: 'plain text message',
                timestamp: Date.now(),
            },
        ]);

        const { useChat } = await import('./useChat');
        const { result } = renderHook(() =>
            useChat('saved', fakeSession, fakeMgr as never),
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(result.current.messages[0].media).toBeUndefined();
        expect(result.current.messages[0].text).toBe('plain text message');
    });

    it('well-formed media JSON is parsed into a media message', async () => {
        const { loadMessages } = await import('@/lib/db');
        const mediaEnvelope = JSON.stringify({
            type: 'media',
            body: 'photo.jpg',
            file: {
                url: 'media/user1/01ABC',
                key: 'base64key',
                iv: 'base64iv',
                name: 'photo.jpg',
                size: 1024,
            },
        });
        vi.mocked(loadMessages).mockResolvedValue([
            {
                id: 'msg2',
                userId: 'user1',
                conversationId: 'self:user1',
                fromUser: 'peer-user',
                fromDevice: 'dev2',
                text: mediaEnvelope,
                timestamp: Date.now(),
            },
        ]);

        const { useChat } = await import('./useChat');
        const { result } = renderHook(() =>
            useChat('saved', fakeSession, fakeMgr as never),
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        const msg = result.current.messages[0];
        expect(msg.text).toBe('photo.jpg'); // body field
        expect(msg.media).toBeDefined();
        expect(msg.media?.name).toBe('photo.jpg');
        expect(msg.media?.size).toBe(1024);
    });

    it('malformed JSON is treated as plain text', async () => {
        const { loadMessages } = await import('@/lib/db');
        vi.mocked(loadMessages).mockResolvedValue([
            {
                id: 'msg3',
                userId: 'user1',
                conversationId: 'self:user1',
                fromUser: 'user1',
                fromDevice: 'dev1',
                text: '{not valid json at all',
                timestamp: Date.now(),
            },
        ]);

        const { useChat } = await import('./useChat');
        const { result } = renderHook(() =>
            useChat('saved', fakeSession, fakeMgr as never),
        );

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(result.current.messages[0].media).toBeUndefined();
        expect(result.current.messages[0].text).toBe('{not valid json at all');
    });
});
