// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/auth';

vi.mock('@/lib/api', () => ({
    resolve: vi.fn().mockResolvedValue({
        status: 'live',
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
    getConversationLastRead: vi.fn().mockResolvedValue(0),
    markConversationRead: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/read-markers', () => ({
    notifyReadMarkersChanged: vi.fn(),
    scheduleReadMarkerPush: vi.fn(),
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
    keyVersion: 1,
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

describe('useChat - amendment materialization', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    interface RowInit {
        id: string;
        fromUser?: string;
        text: string;
    }

    function row({ id, fromUser = 'user1', text }: RowInit) {
        return {
            id,
            userId: 'user1',
            conversationId: 'self:user1',
            fromUser,
            fromDevice: 'dev1',
            text,
            // ULID ids sort chronologically; mirror that in the timestamp so the
            // userId_timestamp ordering the real DB applies is reproduced.
            timestamp: 1_000 + id.charCodeAt(id.length - 1),
        };
    }

    const text = (body: string) => JSON.stringify({ type: 'text', body });
    const amend = (targetMsgId: string, action: string, body?: string) =>
        JSON.stringify({
            type: 'amendment',
            target_msg_id: targetMsgId,
            action,
            ...(body !== undefined ? { body } : {}),
        });

    async function materialize(rows: ReturnType<typeof row>[]) {
        const { loadMessages } = await import('@/lib/db');
        vi.mocked(loadMessages).mockResolvedValue(rows);
        const { useChat } = await import('./useChat');
        const { result } = renderHook(() =>
            useChat('saved', fakeSession, fakeMgr as never),
        );
        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });
        return result;
    }

    it('applies a single edit and tags editedAt', async () => {
        const result = await materialize([
            row({ id: 'A0', text: text('A') }),
            row({ id: 'A1', text: amend('A0', 'edit', 'B') }),
        ]);
        expect(result.current.messages).toHaveLength(1);
        expect(result.current.messages[0].text).toBe('B');
        expect(result.current.messages[0].editedAt).toBeInstanceOf(Date);
    });

    it('applies multiple edits in ULID order — last wins', async () => {
        const result = await materialize([
            row({ id: 'A0', text: text('A') }),
            row({ id: 'A2', text: amend('A0', 'edit', 'second') }),
            row({ id: 'A1', text: amend('A0', 'edit', 'first') }),
        ]);
        expect(result.current.messages[0].text).toBe('second');
    });

    it('delete trumps a subsequent edit', async () => {
        const result = await materialize([
            row({ id: 'A0', text: text('A') }),
            row({ id: 'A1', text: amend('A0', 'edit', 'B') }),
            row({ id: 'A2', text: amend('A0', 'delete') }),
            row({ id: 'A3', text: amend('A0', 'edit', 'C') }),
        ]);
        expect(result.current.messages[0].deleted).toBe(true);
        expect(result.current.messages[0].text).toBe('');
    });

    it('drops an amendment from a different sender (authz)', async () => {
        const result = await materialize([
            row({ id: 'A0', fromUser: 'user1', text: text('A') }),
            row({
                id: 'A1',
                fromUser: 'mallory',
                text: amend('A0', 'edit', 'hax'),
            }),
        ]);
        expect(result.current.messages[0].text).toBe('A');
        expect(result.current.messages[0].editedAt).toBeUndefined();
    });

    it('silently skips an unknown action', async () => {
        const result = await materialize([
            row({ id: 'A0', text: text('A') }),
            row({ id: 'A1', text: amend('A0', 'wat', 'B') }),
        ]);
        expect(result.current.messages[0].text).toBe('A');
        expect(result.current.messages[0].editedAt).toBeUndefined();
        expect(result.current.messages[0].deleted).toBeUndefined();
    });

    it('keeps an orphan amendment unsurfaced, then applies it once the original arrives', async () => {
        const orphan = await materialize([
            row({ id: 'A1', text: amend('A0', 'edit', 'B') }),
        ]);
        expect(orphan.current.messages).toHaveLength(0);

        const resolved = await materialize([
            row({ id: 'A0', text: text('A') }),
            row({ id: 'A1', text: amend('A0', 'edit', 'B') }),
        ]);
        expect(resolved.current.messages).toHaveLength(1);
        expect(resolved.current.messages[0].text).toBe('B');
    });

    it('does not let an amendment target another amendment', async () => {
        // A2 targets A1 (itself an amendment), not the original X.
        const result = await materialize([
            row({ id: 'X0', text: text('X') }),
            row({ id: 'A1', text: amend('X0', 'edit', 'edited') }),
            row({ id: 'A2', text: amend('A1', 'edit', 'hijack') }),
        ]);
        // Only the original is surfaced; its chain (A1) applied; A2 is an orphan.
        expect(result.current.messages).toHaveLength(1);
        expect(result.current.messages[0].text).toBe('edited');
    });

    it('deletes a media message — drops the media reference', async () => {
        const media = JSON.stringify({
            type: 'media',
            body: 'photo.jpg',
            file: {
                url: 'media/user1/01ABC',
                key: 'k',
                iv: 'iv',
                name: 'photo.jpg',
                size: 10,
            },
        });
        const result = await materialize([
            row({ id: 'A0', text: media }),
            row({ id: 'A1', text: amend('A0', 'delete') }),
        ]);
        expect(result.current.messages[0].deleted).toBe(true);
        expect(result.current.messages[0].media).toBeUndefined();
    });

    it('edits a media caption without touching the media reference', async () => {
        const media = JSON.stringify({
            type: 'media',
            body: 'old caption',
            file: {
                url: 'media/user1/01ABC',
                key: 'k',
                iv: 'iv',
                name: 'photo.jpg',
                size: 10,
            },
        });
        const result = await materialize([
            row({ id: 'A0', text: media }),
            row({ id: 'A1', text: amend('A0', 'edit', 'new caption') }),
        ]);
        expect(result.current.messages[0].text).toBe('new caption');
        expect(result.current.messages[0].media).toBeDefined();
        expect(result.current.messages[0].media?.name).toBe('photo.jpg');
    });

    it('ignores an edit on a pure-media message (empty caption)', async () => {
        const media = JSON.stringify({
            type: 'media',
            body: '',
            file: {
                url: 'media/user1/01ABC',
                key: 'k',
                iv: 'iv',
                name: 'photo.jpg',
                size: 10,
            },
        });
        const result = await materialize([
            row({ id: 'A0', text: media }),
            row({ id: 'A1', text: amend('A0', 'edit', 'sneaky caption') }),
        ]);
        expect(result.current.messages[0].text).toBe('');
        expect(result.current.messages[0].editedAt).toBeUndefined();
        expect(result.current.messages[0].media).toBeDefined();
    });

    it('handles a long edit chain (N=50) without quadratic blowup', async () => {
        const rows = [row({ id: 'M000', text: text('orig') })];
        for (let i = 1; i <= 50; i++) {
            const id = `M${String(i).padStart(3, '0')}`;
            rows.push(row({ id, text: amend('M000', 'edit', `edit-${i}`) }));
        }
        const start = performance.now();
        const result = await materialize(rows);
        const elapsed = performance.now() - start;
        expect(result.current.messages).toHaveLength(1);
        expect(result.current.messages[0].text).toBe('edit-50');
        // Generous CI bound — confirms the walk is linear, not accidentally O(n²).
        expect(elapsed).toBeLessThan(500);
    });
});
