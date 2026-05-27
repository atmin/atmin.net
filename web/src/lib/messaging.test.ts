import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    derive_secret,
    MegolmInbound,
    MegolmOutbound,
} from '../../crypto/pkg-node/atmin_crypto.js';
import {
    backupDecrypt,
    base64UrlEncode,
    deriveKeys,
    generateBackupSecret,
} from './crypto';
import {
    clearInboundSessions,
    clearKeyShares,
    clearOutboundSession,
    clearSyncCursors,
    loadSyncCursor,
    saveSyncCursor,
} from './db';
import { createSessionManager } from './megolm-session';
import { fetchMessages, sendTextMessage } from './messaging';
import type { WasmModule } from './wasm';

const fetchMock = vi.fn();
globalThis.fetch = fetchMock as typeof fetch;

function resetFetchMock() {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(
        mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
    );
}
resetFetchMock();

function mockJsonResponse(data: unknown): unknown {
    return {
        ok: true,
        status: 200,
        headers: {
            get: (name: string) =>
                name === 'content-type' ? 'application/json' : null,
        },
        json: async () => data,
    };
}

function mockArrayBufferResponse(buffer: ArrayBuffer): unknown {
    return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buffer,
    };
}

const wasm: WasmModule = {
    MegolmOutbound: MegolmOutbound as unknown as WasmModule['MegolmOutbound'],
    MegolmInbound: MegolmInbound as unknown as WasmModule['MegolmInbound'],
    derive_secret,
};

describe('messaging - Megolm send/receive', () => {
    const token = 'test-token';
    const fromUserId = '01TESTUSER123';
    const fromDeviceId = '01TESTDEVICE456';
    const toUserId = '01TESTUSER789';

    let recipientKeys: Awaited<ReturnType<typeof deriveKeys>>;
    let senderKeys: Awaited<ReturnType<typeof deriveKeys>>;

    beforeEach(async () => {
        resetFetchMock();
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = FakeIDBKeyRange;

        const recipientSecret = generateBackupSecret();
        recipientKeys = await deriveKeys(recipientSecret);
        const senderSecret = generateBackupSecret();
        senderKeys = await deriveKeys(senderSecret);
    });

    afterEach(async () => {
        await clearOutboundSession();
        await clearInboundSessions();
        await clearKeyShares();
        await clearSyncCursors();
    });

    describe('sendTextMessage', () => {
        it('produces key_share + message envelopes on first send', async () => {
            const mgr = await createSessionManager(wasm);
            fetchMock.mockResolvedValueOnce(mockJsonResponse({}) as Response);

            await sendTextMessage(
                token,
                fromUserId,
                fromDeviceId,
                toUserId,
                recipientKeys.sharing.publicKeyBytes,
                senderKeys.sharing.publicKeyBytes,
                'Hello Megolm!',
                mgr,
            );

            const fetchCall = fetchMock.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);

            expect(body.envelopes).toHaveLength(4);

            const keyShares = body.envelopes.filter(
                (e: { content_type: string }) =>
                    e.content_type === 'megolm.key_share',
            );
            const messages = body.envelopes.filter(
                (e: { content_type: string }) =>
                    e.content_type === 'megolm.message',
            );

            expect(keyShares).toHaveLength(2);
            expect(keyShares[0].to_user).toBe(toUserId);
            expect(keyShares[1].to_user).toBe(fromUserId);
            expect(keyShares[0].payload).toHaveProperty('ephemeral_key');

            expect(messages).toHaveLength(2);
            expect(messages[0].payload).toHaveProperty('session_id');
            expect(messages[0].payload).toHaveProperty('ciphertext');

            const recipients = messages.map(
                (m: { to_user: string }) => m.to_user,
            );
            expect(recipients).toContain(toUserId);
            expect(recipients).toContain(fromUserId);

            mgr.destroy();
        });

        it('skips key_share on subsequent sends to same recipient', async () => {
            const mgr = await createSessionManager(wasm);

            fetchMock.mockResolvedValueOnce(mockJsonResponse({}) as Response);
            await sendTextMessage(
                token,
                fromUserId,
                fromDeviceId,
                toUserId,
                recipientKeys.sharing.publicKeyBytes,
                senderKeys.sharing.publicKeyBytes,
                'First',
                mgr,
            );

            fetchMock.mockResolvedValueOnce(mockJsonResponse({}) as Response);
            await sendTextMessage(
                token,
                fromUserId,
                fromDeviceId,
                toUserId,
                recipientKeys.sharing.publicKeyBytes,
                senderKeys.sharing.publicKeyBytes,
                'Second',
                mgr,
            );

            const body2 = JSON.parse(fetchMock.mock.calls[1][1].body);

            const keyShares = body2.envelopes.filter(
                (e: { content_type: string }) =>
                    e.content_type === 'megolm.key_share',
            );
            expect(keyShares).toHaveLength(0);
            expect(body2.envelopes).toHaveLength(2);

            mgr.destroy();
        });
    });

    describe('fetchMessages with Megolm', () => {
        it('processes key_share before megolm.message', async () => {
            const mgr = await createSessionManager(wasm);

            const sender = new MegolmOutbound();
            const sessionKey = sender.session_key();
            const ciphertext = sender.encrypt('Hello from Megolm');

            const { eciesEncrypt } = await import('./crypto');
            const encryptedKey = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode(sessionKey),
            );

            const keyShareEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-001',
                content_type: 'megolm.key_share',
                sent_at: new Date(Date.now() - 1000).toISOString(),
                payload: {
                    ephemeral_key: base64UrlEncode(encryptedKey.ephemeralKey),
                    iv: base64UrlEncode(encryptedKey.iv),
                    ciphertext: base64UrlEncode(encryptedKey.ciphertext),
                },
            };

            const messageEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-002',
                content_type: 'megolm.message',
                sent_at: new Date().toISOString(),
                payload: {
                    session_id: sender.session_id,
                    ciphertext,
                },
            };

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [
                        `inbox/${toUserId}/live/msg-001`,
                        `inbox/${toUserId}/live/msg-002`,
                    ],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(
                            JSON.stringify(keyShareEnvelope),
                        ).buffer,
                    ) as Response,
                )
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(
                            JSON.stringify(messageEnvelope),
                        ).buffer,
                    ) as Response,
                );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            expect(messages).toHaveLength(1);
            expect(messages[0].text).toBe('Hello from Megolm');
            expect(messages[0].fromUser).toBe(fromUserId);

            sender.free();
            mgr.destroy();
        });

        it('skips messages with unknown session_id', async () => {
            const mgr = await createSessionManager(wasm);

            const messageEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-unknown',
                content_type: 'megolm.message',
                sent_at: new Date().toISOString(),
                payload: {
                    session_id: 'nonexistent-session',
                    ciphertext: 'some-ciphertext',
                },
            };

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`inbox/${toUserId}/live/msg-unknown`],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(messageEnvelope))
                        .buffer,
                ) as Response,
            );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            expect(messages).toHaveLength(0);

            mgr.destroy();
        });
    });

    describe('cursor persistence', () => {
        it('persists cursor after fetching messages', async () => {
            const mgr = await createSessionManager(wasm);

            const sender = new MegolmOutbound();
            const { eciesEncrypt } = await import('./crypto');
            const encryptedKey = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode(sender.session_key()),
            );

            const keyShareEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-ks-001',
                content_type: 'megolm.key_share',
                sent_at: new Date(Date.now() - 1000).toISOString(),
                payload: {
                    ephemeral_key: base64UrlEncode(encryptedKey.ephemeralKey),
                    iv: base64UrlEncode(encryptedKey.iv),
                    ciphertext: base64UrlEncode(encryptedKey.ciphertext),
                },
            };

            const messageEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-001',
                content_type: 'megolm.message',
                sent_at: new Date().toISOString(),
                payload: {
                    session_id: sender.session_id,
                    ciphertext: sender.encrypt('Message one'),
                },
            };

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [
                        `inbox/${toUserId}/live/msg-ks-001`,
                        `inbox/${toUserId}/live/msg-001`,
                    ],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(
                            JSON.stringify(keyShareEnvelope),
                        ).buffer,
                    ) as Response,
                )
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(
                            JSON.stringify(messageEnvelope),
                        ).buffer,
                    ) as Response,
                );

            await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            const cursor = await loadSyncCursor(`inbox/${toUserId}/live/`);
            expect(cursor).toBe(`inbox/${toUserId}/live/msg-001`);

            sender.free();
            mgr.destroy();
        });

        it('passes stored cursor to storeList on subsequent syncs', async () => {
            const mgr = await createSessionManager(wasm);

            const prefix = `inbox/${toUserId}/live/`;
            await saveSyncCursor(prefix, `${prefix}msg-001`);

            const sender = new MegolmOutbound();
            const { eciesEncrypt } = await import('./crypto');
            const encryptedKey = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode(sender.session_key()),
            );

            const keyShareEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-ks-002',
                content_type: 'megolm.key_share',
                sent_at: new Date(Date.now() - 1000).toISOString(),
                payload: {
                    ephemeral_key: base64UrlEncode(encryptedKey.ephemeralKey),
                    iv: base64UrlEncode(encryptedKey.iv),
                    ciphertext: base64UrlEncode(encryptedKey.ciphertext),
                },
            };

            const messageEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-002',
                content_type: 'megolm.message',
                sent_at: new Date().toISOString(),
                payload: {
                    session_id: sender.session_id,
                    ciphertext: sender.encrypt('Message two'),
                },
            };

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`${prefix}msg-ks-002`, `${prefix}msg-002`],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(
                            JSON.stringify(keyShareEnvelope),
                        ).buffer,
                    ) as Response,
                )
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(
                            JSON.stringify(messageEnvelope),
                        ).buffer,
                    ) as Response,
                );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            const listCall = fetchMock.mock.calls[0];
            expect(listCall[0]).toContain(
                `cursor=${encodeURIComponent(`${prefix}msg-001`)}`,
            );

            const cursor = await loadSyncCursor(prefix);
            expect(cursor).toBe(`${prefix}msg-002`);

            expect(messages).toHaveLength(1);
            expect(messages[0].text).toBe('Message two');

            sender.free();
            mgr.destroy();
        });

        it('does not update cursor when no keys returned', async () => {
            const mgr = await createSessionManager(wasm);

            const prefix = `inbox/${toUserId}/live/`;
            await saveSyncCursor(prefix, `${prefix}msg-005`);

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [],
                    next_cursor: '',
                }) as Response,
            );

            await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            const cursor = await loadSyncCursor(prefix);
            expect(cursor).toBe(`${prefix}msg-005`);

            mgr.destroy();
        });

        it('falls back to full fetch when cursor causes error', async () => {
            const mgr = await createSessionManager(wasm);

            const prefix = `inbox/${toUserId}/live/`;
            await saveSyncCursor(prefix, `${prefix}stale-cursor`);

            const sender = new MegolmOutbound();
            const { eciesEncrypt } = await import('./crypto');
            const encryptedKey = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode(sender.session_key()),
            );

            const keyShareEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-ks-001',
                content_type: 'megolm.key_share',
                sent_at: new Date(Date.now() - 1000).toISOString(),
                payload: {
                    ephemeral_key: base64UrlEncode(encryptedKey.ephemeralKey),
                    iv: base64UrlEncode(encryptedKey.iv),
                    ciphertext: base64UrlEncode(encryptedKey.ciphertext),
                },
            };

            const messageEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-001',
                content_type: 'megolm.message',
                sent_at: new Date().toISOString(),
                payload: {
                    session_id: sender.session_id,
                    ciphertext: sender.encrypt('Recovered message'),
                },
            };

            fetchMock.mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                json: async () => ({
                    error: 'internal',
                    message: 'List failed',
                }),
            } as Response);

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`${prefix}msg-ks-001`, `${prefix}msg-001`],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(
                            JSON.stringify(keyShareEnvelope),
                        ).buffer,
                    ) as Response,
                )
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(
                            JSON.stringify(messageEnvelope),
                        ).buffer,
                    ) as Response,
                );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            expect(fetchMock.mock.calls[0][0]).toContain('cursor=');
            expect(fetchMock.mock.calls[1][0]).not.toContain('cursor=');

            expect(messages).toHaveLength(1);
            expect(messages[0].text).toBe('Recovered message');

            sender.free();
            mgr.destroy();
        });
    });

    describe('fetchMessages with archives', () => {
        it('decodes CBOR archive envelopes alongside live messages', async () => {
            const { encode: cborEncode } = await import('cbor-x');
            const mgr = await createSessionManager(wasm);

            const sender = new MegolmOutbound();
            const sessionKey = sender.session_key();

            const { eciesEncrypt } = await import('./crypto');
            const encryptedKey = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode(sessionKey),
            );

            const keyShareEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-ks-001',
                content_type: 'megolm.key_share',
                sent_at: new Date(Date.now() - 3000).toISOString(),
                payload: {
                    ephemeral_key: base64UrlEncode(encryptedKey.ephemeralKey),
                    iv: base64UrlEncode(encryptedKey.iv),
                    ciphertext: base64UrlEncode(encryptedKey.ciphertext),
                },
            };

            const liveMsg = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-live-001',
                content_type: 'megolm.message',
                sent_at: new Date(Date.now() - 1000).toISOString(),
                payload: {
                    session_id: sender.session_id,
                    ciphertext: sender.encrypt('Live message'),
                },
            };

            const archivedMsg = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-archived-001',
                content_type: 'megolm.message',
                sent_at: new Date(Date.now() - 5000).toISOString(),
                payload: {
                    session_id: sender.session_id,
                    ciphertext: sender.encrypt('Archived message'),
                },
            };

            const archiveCborBytes = cborEncode([
                keyShareEnvelope,
                archivedMsg,
            ]);
            const archiveCbor = new Uint8Array(archiveCborBytes).buffer;

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [
                        `inbox/${toUserId}/live/msg-ks-001`,
                        `inbox/${toUserId}/live/msg-live-001`,
                    ],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(keyShareEnvelope))
                        .buffer,
                ) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(liveMsg)).buffer,
                ) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`inbox/${toUserId}/archive/2025-01-15-01ARCHIVEID`],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(archiveCbor) as Response,
            );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            expect(messages).toHaveLength(2);
            const texts = messages.map((m) => m.text);
            expect(texts).toContain('Live message');
            expect(texts).toContain('Archived message');
            expect(messages[0].text).toBe('Archived message');
            expect(messages[1].text).toBe('Live message');

            sender.free();
            mgr.destroy();
        });

        it('deduplicates archive messages against live messages by msg_id', async () => {
            const { encode: cborEncode } = await import('cbor-x');
            const mgr = await createSessionManager(wasm);

            const sender = new MegolmOutbound();
            const sessionKey = sender.session_key();

            const { eciesEncrypt } = await import('./crypto');
            const encryptedKey = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode(sessionKey),
            );

            const keyShareEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-ks-dup',
                content_type: 'megolm.key_share',
                sent_at: new Date(Date.now() - 3000).toISOString(),
                payload: {
                    ephemeral_key: base64UrlEncode(encryptedKey.ephemeralKey),
                    iv: base64UrlEncode(encryptedKey.iv),
                    ciphertext: base64UrlEncode(encryptedKey.ciphertext),
                },
            };

            const sharedMsgId = 'msg-same-id';
            const msgEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: sharedMsgId,
                content_type: 'megolm.message',
                sent_at: new Date().toISOString(),
                payload: {
                    session_id: sender.session_id,
                    ciphertext: sender.encrypt('Duplicated message'),
                },
            };

            const archiveCborBytes = cborEncode([
                keyShareEnvelope,
                msgEnvelope,
            ]);
            const archiveCbor = new Uint8Array(archiveCborBytes).buffer;

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [
                        `inbox/${toUserId}/live/msg-ks-dup`,
                        `inbox/${toUserId}/live/${sharedMsgId}`,
                    ],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(keyShareEnvelope))
                        .buffer,
                ) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(msgEnvelope))
                        .buffer,
                ) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`inbox/${toUserId}/archive/2025-01-15-01ARCHIVEID`],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(archiveCbor) as Response,
            );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            expect(messages).toHaveLength(1);
            expect(messages[0].id).toBe(sharedMsgId);

            sender.free();
            mgr.destroy();
        });

        it('returns empty when archive list fails', async () => {
            const mgr = await createSessionManager(wasm);

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                headers: {
                    get: () => 'application/json',
                },
                json: async () => ({
                    error: 'internal',
                    message: 'Archive list failed',
                }),
            } as unknown as Response);

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            expect(messages).toHaveLength(0);
            mgr.destroy();
        });

        it('persists archive cursor after fetching archives', async () => {
            const { encode: cborEncode } = await import('cbor-x');
            const mgr = await createSessionManager(wasm);
            const archivePrefix = `inbox/${toUserId}/archive/`;
            const archiveKey = `${archivePrefix}2026-01-15-01ARCHIVEID1`;

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [archiveKey],
                    next_cursor: '',
                }) as Response,
            );
            const emptyCbor = new Uint8Array(cborEncode([])).buffer;
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(emptyCbor) as Response,
            );

            await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            const cursor = await loadSyncCursor(archivePrefix);
            expect(cursor).toBe(archiveKey);

            mgr.destroy();
        });

        it('passes stored archive cursor to storeList on subsequent syncs', async () => {
            const mgr = await createSessionManager(wasm);
            const archivePrefix = `inbox/${toUserId}/archive/`;
            const priorArchiveKey = `${archivePrefix}2026-01-14-01ARCHIVEID0`;

            await saveSyncCursor(archivePrefix, priorArchiveKey);

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
            );

            await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            expect(fetchMock.mock.calls[1][0]).toContain(
                `cursor=${encodeURIComponent(priorArchiveKey)}`,
            );

            mgr.destroy();
        });

        it('falls back to full archive fetch when archive cursor is stale', async () => {
            const { encode: cborEncode } = await import('cbor-x');
            const mgr = await createSessionManager(wasm);
            const archivePrefix = `inbox/${toUserId}/archive/`;
            const staleKey = `${archivePrefix}2026-01-01-01STALEID`;
            const freshArchiveKey = `${archivePrefix}2026-01-15-01ARCHIVEID1`;

            await saveSyncCursor(archivePrefix, staleKey);

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
            );
            fetchMock.mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                headers: { get: () => 'application/json' },
                json: async () => ({
                    error: 'internal',
                    message: 'Stale cursor',
                }),
            } as unknown as Response);
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [freshArchiveKey],
                    next_cursor: '',
                }) as Response,
            );
            const emptyCbor = new Uint8Array(cborEncode([])).buffer;
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(emptyCbor) as Response,
            );

            await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            expect(fetchMock.mock.calls[1][0]).toContain('cursor=');
            expect(fetchMock.mock.calls[2][0]).not.toContain('cursor=');

            const cursor = await loadSyncCursor(archivePrefix);
            expect(cursor).toBe(freshArchiveKey);

            mgr.destroy();
        });
    });

    describe('fetchMessages compaction', () => {
        it('triggers compaction after syncing live messages', async () => {
            const mgr = await createSessionManager(wasm);

            const sender = new MegolmOutbound();
            const { eciesEncrypt } = await import('./crypto');
            const encryptedKey = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode(sender.session_key()),
            );

            const keyShareEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-ks-compact',
                content_type: 'megolm.key_share',
                sent_at: new Date(Date.now() - 1000).toISOString(),
                payload: {
                    ephemeral_key: base64UrlEncode(encryptedKey.ephemeralKey),
                    iv: base64UrlEncode(encryptedKey.iv),
                    ciphertext: base64UrlEncode(encryptedKey.ciphertext),
                },
            };

            const messageEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-compact-001',
                content_type: 'megolm.message',
                sent_at: new Date().toISOString(),
                payload: {
                    session_id: sender.session_id,
                    ciphertext: sender.encrypt('Hello'),
                },
            };

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [
                        `inbox/${toUserId}/live/msg-ks-compact`,
                        `inbox/${toUserId}/live/msg-compact-001`,
                    ],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(keyShareEnvelope))
                        .buffer,
                ) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(messageEnvelope))
                        .buffer,
                ) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    archived: 1,
                    archive_key: `inbox/${toUserId}/archive/2025-01-15-01ARCHIVEID`,
                }) as Response,
            );

            await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            const compactCall = fetchMock.mock.calls.find(
                (call: unknown[]) => call[0] === '/v1/store/compact',
            );
            expect(compactCall).toBeDefined();
            const body = JSON.parse(compactCall?.[1].body);
            expect(body.prefix).toBe(`inbox/${toUserId}/live/`);
            expect(body.up_to).toBe('msg-compact-001');

            sender.free();
            mgr.destroy();
        });

        it('skips compaction when no live messages are fetched', async () => {
            const mgr = await createSessionManager(wasm);

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [],
                    next_cursor: '',
                }) as Response,
            );

            await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            const compactCall = fetchMock.mock.calls.find(
                (call: unknown[]) => call[0] === '/v1/store/compact',
            );
            expect(compactCall).toBeUndefined();

            mgr.destroy();
        });
    });
});

describe('messaging - key-share backup', () => {
    const token = 'test-token';
    const userId = '01TESTUSER123';
    const fromUserId = '01TESTUSER456';
    const fromDeviceId = '01TESTDEVICE789';

    let recipientKeys: Awaited<ReturnType<typeof deriveKeys>>;

    beforeEach(async () => {
        resetFetchMock();
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = FakeIDBKeyRange;

        recipientKeys = await deriveKeys(generateBackupSecret());
    });

    afterEach(async () => {
        await clearOutboundSession();
        await clearInboundSessions();
        await clearKeyShares();
        await clearSyncCursors();
    });

    it('backs up received session key via storePresign on first key-share arrival', async () => {
        const mgr = await createSessionManager(wasm);
        const sender = new MegolmOutbound();
        const sessionKey = sender.session_key();
        const { eciesEncrypt } = await import('./crypto');
        const encryptedKey = await eciesEncrypt(
            recipientKeys.sharing.publicKey,
            new TextEncoder().encode(sessionKey),
        );

        const keyShareEnvelope = {
            v: 1,
            to_user: userId,
            from_user: fromUserId,
            from_device: fromDeviceId,
            msg_id: 'msg-ks-backup-01',
            content_type: 'megolm.key_share',
            sent_at: new Date().toISOString(),
            payload: {
                ephemeral_key: base64UrlEncode(encryptedKey.ephemeralKey),
                iv: base64UrlEncode(encryptedKey.iv),
                ciphertext: base64UrlEncode(encryptedKey.ciphertext),
            },
        };

        const presignedUrl = 'https://s3.example.com/presigned-backup';
        const envelopeBytes = new TextEncoder().encode(
            JSON.stringify(keyShareEnvelope),
        ).buffer;
        fetchMock.mockImplementation(
            async (url: string | URL | Request, init?: RequestInit) => {
                const urlStr =
                    typeof url === 'string'
                        ? url
                        : url instanceof URL
                          ? url.href
                          : (url as Request).url;
                if (urlStr === presignedUrl && init?.method === 'PUT') {
                    return new Response(null, { status: 200 });
                }
                if (urlStr === '/v1/store/presign') {
                    return mockJsonResponse({
                        presigned_url: presignedUrl,
                    }) as Response;
                }
                if (urlStr.startsWith('/v1/store/object')) {
                    return mockArrayBufferResponse(envelopeBytes) as Response;
                }
                if (urlStr.startsWith('/v1/store/list')) {
                    const prefix =
                        new URLSearchParams(urlStr.split('?')[1] ?? '').get(
                            'prefix',
                        ) ?? '';
                    if (prefix === `inbox/${userId}/live/`) {
                        return mockJsonResponse({
                            keys: [`inbox/${userId}/live/msg-ks-backup-01`],
                            next_cursor: '',
                        }) as Response;
                    }
                }
                return mockJsonResponse({
                    keys: [],
                    next_cursor: '',
                }) as Response;
            },
        );

        await fetchMessages(
            token,
            userId,
            recipientKeys.sharing.privateKey,
            mgr,
            recipientKeys.backupKey,
        );

        await vi.waitFor(() => {
            const done = fetchMock.mock.calls.some(
                (call) => (call[0] as string) === '/v1/store/presign',
            );
            if (!done) throw new Error('storePresign not yet called');
        });

        const presignCall = fetchMock.mock.calls.find(
            (call) => (call[0] as string) === '/v1/store/presign',
        );
        expect(presignCall).toBeDefined();
        const presignBody = JSON.parse(presignCall?.[1].body as string);
        expect(presignBody.key).toBe(
            `keys/${userId}/live/${sender.session_id}`,
        );

        const putCall = fetchMock.mock.calls.find(
            (call) => (call[0] as string) === presignedUrl,
        );
        expect(putCall).toBeDefined();
        const putBody = JSON.parse(
            new TextDecoder().decode(putCall?.[1].body as Uint8Array),
        );
        const ivBytes = Uint8Array.from(atob(putBody.iv), (c) =>
            c.charCodeAt(0),
        );
        const ctBytes = Uint8Array.from(atob(putBody.ciphertext), (c) =>
            c.charCodeAt(0),
        );
        const decrypted = await backupDecrypt(recipientKeys.backupKey, {
            iv: ivBytes,
            ciphertext: ctBytes,
        });
        expect(new TextDecoder().decode(decrypted)).toBe(sessionKey);

        sender.free();
        mgr.destroy();
    });

    it('skips backup on second arrival of the same key share (session already known)', async () => {
        const mgr = await createSessionManager(wasm);
        const sender = new MegolmOutbound();
        const sessionKey = sender.session_key();
        const { eciesEncrypt } = await import('./crypto');
        const encryptedKey = await eciesEncrypt(
            recipientKeys.sharing.publicKey,
            new TextEncoder().encode(sessionKey),
        );

        const keyShareEnvelope = {
            v: 1,
            to_user: userId,
            from_user: fromUserId,
            from_device: fromDeviceId,
            msg_id: 'msg-ks-backup-02',
            content_type: 'megolm.key_share',
            sent_at: new Date().toISOString(),
            payload: {
                ephemeral_key: base64UrlEncode(encryptedKey.ephemeralKey),
                iv: base64UrlEncode(encryptedKey.iv),
                ciphertext: base64UrlEncode(encryptedKey.ciphertext),
            },
        };

        const mockKeyShareFetch = () => {
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`inbox/${userId}/live/msg-ks-backup-02`],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(keyShareEnvelope))
                        .buffer,
                ) as Response,
            );
        };

        mockKeyShareFetch();
        fetchMock.mockResolvedValueOnce(
            mockJsonResponse({
                presigned_url: 'https://s3.example.com/backup1',
            }) as Response,
        );
        fetchMock.mockResolvedValueOnce({ ok: true, status: 200 } as Response);
        fetchMock.mockResolvedValueOnce(
            mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
        );

        await fetchMessages(
            token,
            userId,
            recipientKeys.sharing.privateKey,
            mgr,
            recipientKeys.backupKey,
        );

        // Backup upload is fire-and-forget; wait for it.
        await vi.waitFor(() => {
            const count = fetchMock.mock.calls.filter(
                (call) => (call[0] as string) === '/v1/store/presign',
            ).length;
            if (count !== 1) throw new Error(`presign count=${count}, want 1`);
        });

        resetFetchMock();

        mockKeyShareFetch();
        fetchMock.mockResolvedValueOnce(
            mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
        );

        await fetchMessages(
            token,
            userId,
            recipientKeys.sharing.privateKey,
            mgr,
            recipientKeys.backupKey,
        );

        // Give any stray backup a tick to fire before asserting it didn't.
        await new Promise((r) => setTimeout(r, 50));
        const presignCountAfterSecond = fetchMock.mock.calls.filter(
            (call) => (call[0] as string) === '/v1/store/presign',
        ).length;
        expect(presignCountAfterSecond).toBe(0);

        sender.free();
        mgr.destroy();
    });
});
