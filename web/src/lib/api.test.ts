import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MegolmInbound,
    MegolmOutbound,
} from '../../crypto/pkg-node/atmin_crypto.js';
import {
    compactAfterRotation,
    fetchMessages,
    type RegisterRequest,
    register,
    resolve,
    sendTextMessage,
} from './api';
import { base64UrlEncode, deriveKeys, generateBackupSecret } from './crypto';
import {
    clearInboundSessions,
    clearKeyShares,
    clearOutboundSession,
    clearSyncCursors,
    loadSyncCursor,
    saveSyncCursor,
} from './db';
import { createSessionManager } from './megolm-session';
import type { WasmModule } from './wasm';

// Setup fetch mock
const fetchMock = vi.fn();
globalThis.fetch = fetchMock as typeof fetch;

// Helper to create mock Response with proper headers
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

describe('api - resolve()', () => {
    it('resolves a valid handle to user info', async () => {
        const mockResponse = {
            user_id: '01TESTUSER123',
            sharing_public_key: 'base64url-encoded-public-key',
        };

        fetchMock.mockResolvedValueOnce(
            mockJsonResponse(mockResponse) as Response,
        );

        const result = await resolve('copper-falcon');

        expect(fetchMock).toHaveBeenCalledWith(
            '/v1/resolve/copper-falcon',
            expect.objectContaining({
                method: 'GET',
            }),
        );

        expect(result).toEqual(mockResponse);
        expect(result.user_id).toBe('01TESTUSER123');
        expect(result.sharing_public_key).toBe('base64url-encoded-public-key');
    });

    it('URL-encodes special characters in handle', async () => {
        const mockResponse = {
            user_id: '01TESTUSER456',
            sharing_public_key: 'test-key',
        };

        fetchMock.mockResolvedValueOnce(
            mockJsonResponse(mockResponse) as Response,
        );

        await resolve('test handle with spaces');

        expect(fetchMock).toHaveBeenCalledWith(
            '/v1/resolve/test%20handle%20with%20spaces',
            expect.anything(),
        );
    });

    it('throws APIError when handle not found (404)', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            json: async () => ({
                error: 'not_found',
                message: 'Handle not found',
            }),
        } as Response);

        await expect(resolve('nonexistent-handle')).rejects.toMatchObject({
            status: 404,
            code: 'not_found',
            message: 'Handle not found',
        });
    });

    it('throws APIError on server error (500)', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => ({
                error: 'server_error',
                message: 'Something went wrong',
            }),
        } as Response);

        await expect(resolve('any-handle')).rejects.toMatchObject({
            status: 500,
            code: 'server_error',
        });
    });

    it('throws APIError when response is not JSON', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            json: async () => {
                throw new Error('Not JSON');
            },
        } as unknown as Response);

        await expect(resolve('any-handle')).rejects.toMatchObject({
            status: 503,
            code: 'unknown',
            message: 'Service Unavailable',
        });
    });

    it('handles empty handle gracefully', async () => {
        const mockResponse = {
            user_id: '01TESTUSER789',
            sharing_public_key: 'test-key',
        };

        fetchMock.mockResolvedValueOnce(
            mockJsonResponse(mockResponse) as Response,
        );

        await resolve('');

        expect(fetchMock).toHaveBeenCalledWith(
            '/v1/resolve/',
            expect.anything(),
        );
    });
});

describe('api - register()', () => {
    beforeEach(() => {
        fetchMock.mockReset();
    });

    it('successfully registers a new user with valid keys', async () => {
        const mockResponse = {
            user_id: '01NEWUSER123',
            device_id: '01NEWDEVICE456',
            token: 'new-auth-token-abc123',
            invite_handle: 'copper-falcon',
        };

        fetchMock.mockResolvedValueOnce(
            mockJsonResponse(mockResponse) as Response,
        );

        const request: RegisterRequest = {
            device_label: 'My Phone',
            auth_public_key: 'auth-key-base64url',
            sharing_public_key: 'sharing-key-base64url',
        };

        const result = await register(request);

        // Verify request was made correctly
        expect(fetchMock).toHaveBeenCalledWith(
            '/v1/register',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                }),
            }),
        );

        // Verify request body
        const fetchCall = fetchMock.mock.calls[0];
        const body = JSON.parse(fetchCall[1].body);
        expect(body).toEqual(request);

        // Verify response
        expect(result).toEqual(mockResponse);
        expect(result.user_id).toBe('01NEWUSER123');
        expect(result.device_id).toBe('01NEWDEVICE456');
        expect(result.token).toBe('new-auth-token-abc123');
        expect(result.invite_handle).toBe('copper-falcon');
    });

    it('throws APIError when device_label is missing (400)', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({
                error: 'validation_error',
                message: 'device_label is required',
            }),
        } as Response);

        const invalidRequest: RegisterRequest = {
            device_label: '',
            auth_public_key: 'auth-key',
            sharing_public_key: 'sharing-key',
        };

        await expect(register(invalidRequest)).rejects.toMatchObject({
            status: 400,
            code: 'validation_error',
            message: 'device_label is required',
        });
    });

    it('throws APIError when public keys are invalid (400)', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({
                error: 'validation_error',
                message: 'Invalid public key format',
            }),
        } as Response);

        const invalidRequest: RegisterRequest = {
            device_label: 'My Device',
            auth_public_key: 'not-valid-base64url!!!',
            sharing_public_key: 'also-invalid!!!',
        };

        await expect(register(invalidRequest)).rejects.toMatchObject({
            status: 400,
            code: 'validation_error',
            message: 'Invalid public key format',
        });
    });

    it('throws APIError on server error (500)', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 500,
            statusText: 'Internal Server Error',
            json: async () => ({
                error: 'server_error',
                message: 'Database connection failed',
            }),
        } as Response);

        const request: RegisterRequest = {
            device_label: 'My Device',
            auth_public_key: 'auth-key',
            sharing_public_key: 'sharing-key',
        };

        await expect(register(request)).rejects.toMatchObject({
            status: 500,
            code: 'server_error',
        });
    });

    it('throws APIError when response is not JSON', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 503,
            statusText: 'Service Unavailable',
            json: async () => {
                throw new Error('Not JSON');
            },
        } as unknown as Response);

        const request: RegisterRequest = {
            device_label: 'My Device',
            auth_public_key: 'auth-key',
            sharing_public_key: 'sharing-key',
        };

        await expect(register(request)).rejects.toMatchObject({
            status: 503,
            code: 'unknown',
            message: 'Service Unavailable',
        });
    });

    it('handles rate limiting (429)', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 429,
            statusText: 'Too Many Requests',
            json: async () => ({
                error: 'rate_limit',
                message: 'Too many registration attempts',
            }),
        } as Response);

        const request: RegisterRequest = {
            device_label: 'My Device',
            auth_public_key: 'auth-key',
            sharing_public_key: 'sharing-key',
        };

        await expect(register(request)).rejects.toMatchObject({
            status: 429,
            code: 'rate_limit',
            message: 'Too many registration attempts',
        });
    });
});

// --- Megolm tests ---

const wasm: WasmModule = {
    MegolmOutbound: MegolmOutbound as unknown as WasmModule['MegolmOutbound'],
    MegolmInbound: MegolmInbound as unknown as WasmModule['MegolmInbound'],
};

describe('api - Megolm send/receive', () => {
    const token = 'test-token';
    const fromUserId = '01TESTUSER123';
    const fromDeviceId = '01TESTDEVICE456';
    const toUserId = '01TESTUSER789';

    let recipientKeys: Awaited<ReturnType<typeof deriveKeys>>;
    let senderKeys: Awaited<ReturnType<typeof deriveKeys>>;

    beforeEach(async () => {
        fetchMock.mockReset();
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

            // key_share to recipient + key_share to self + message to recipient + self-copy = 4 envelopes
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

        it('still handles legacy text/plain messages', async () => {
            const mgr = await createSessionManager(wasm);
            const { eciesEncrypt } = await import('./crypto');

            const encrypted = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode('Legacy message'),
            );

            const legacyEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-legacy',
                content_type: 'text/plain',
                sent_at: new Date().toISOString(),
                payload: {
                    ephemeral_key: base64UrlEncode(encrypted.ephemeralKey),
                    iv: base64UrlEncode(encrypted.iv),
                    ciphertext: base64UrlEncode(encrypted.ciphertext),
                },
            };

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`inbox/${toUserId}/live/msg-legacy`],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(legacyEnvelope))
                        .buffer,
                ) as Response,
            );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            expect(messages).toHaveLength(1);
            expect(messages[0].text).toBe('Legacy message');

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
            const { eciesEncrypt } = await import('./crypto');

            const encrypted = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode('Message one'),
            );

            const envelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-001',
                content_type: 'text/plain',
                sent_at: new Date().toISOString(),
                payload: {
                    ephemeral_key: base64UrlEncode(encrypted.ephemeralKey),
                    iv: base64UrlEncode(encrypted.iv),
                    ciphertext: base64UrlEncode(encrypted.ciphertext),
                },
            };

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`inbox/${toUserId}/live/msg-001`],
                    next_cursor: '',
                }) as Response,
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(envelope)).buffer,
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

            mgr.destroy();
        });

        it('passes stored cursor to storeList on subsequent syncs', async () => {
            const mgr = await createSessionManager(wasm);

            // Pre-seed a cursor to simulate a previous sync
            const prefix = `inbox/${toUserId}/live/`;
            await saveSyncCursor(prefix, `${prefix}msg-001`);

            // Second sync: server returns only new messages
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`${prefix}msg-002`],
                    next_cursor: '',
                }) as Response,
            );

            const { eciesEncrypt } = await import('./crypto');
            const encrypted = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode('Message two'),
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(
                        JSON.stringify({
                            v: 1,
                            to_user: toUserId,
                            from_user: fromUserId,
                            from_device: fromDeviceId,
                            msg_id: 'msg-002',
                            content_type: 'text/plain',
                            sent_at: new Date().toISOString(),
                            payload: {
                                ephemeral_key: base64UrlEncode(
                                    encrypted.ephemeralKey,
                                ),
                                iv: base64UrlEncode(encrypted.iv),
                                ciphertext: base64UrlEncode(
                                    encrypted.ciphertext,
                                ),
                            },
                        }),
                    ).buffer,
                ) as Response,
            );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            // Verify cursor was passed to storeList
            const listCall = fetchMock.mock.calls[0];
            expect(listCall[0]).toContain(
                `cursor=${encodeURIComponent(`${prefix}msg-001`)}`,
            );

            // Verify cursor was updated
            const cursor = await loadSyncCursor(prefix);
            expect(cursor).toBe(`${prefix}msg-002`);

            expect(messages).toHaveLength(1);
            expect(messages[0].text).toBe('Message two');

            mgr.destroy();
        });

        it('does not update cursor when no keys returned', async () => {
            const mgr = await createSessionManager(wasm);

            const prefix = `inbox/${toUserId}/live/`;
            await saveSyncCursor(prefix, `${prefix}msg-005`);

            // Server returns no new messages
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

            // Cursor should remain unchanged
            const cursor = await loadSyncCursor(prefix);
            expect(cursor).toBe(`${prefix}msg-005`);

            mgr.destroy();
        });

        it('falls back to full fetch when cursor causes error', async () => {
            const mgr = await createSessionManager(wasm);

            const prefix = `inbox/${toUserId}/live/`;
            await saveSyncCursor(prefix, `${prefix}stale-cursor`);

            // First call with cursor fails
            fetchMock.mockResolvedValueOnce({
                ok: false,
                status: 500,
                statusText: 'Internal Server Error',
                json: async () => ({
                    error: 'internal',
                    message: 'List failed',
                }),
            } as Response);

            // Retry without cursor succeeds
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`${prefix}msg-001`],
                    next_cursor: '',
                }) as Response,
            );

            const { eciesEncrypt } = await import('./crypto');
            const encrypted = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode('Recovered message'),
            );
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(
                        JSON.stringify({
                            v: 1,
                            to_user: toUserId,
                            from_user: fromUserId,
                            from_device: fromDeviceId,
                            msg_id: 'msg-001',
                            content_type: 'text/plain',
                            sent_at: new Date().toISOString(),
                            payload: {
                                ephemeral_key: base64UrlEncode(
                                    encrypted.ephemeralKey,
                                ),
                                iv: base64UrlEncode(encrypted.iv),
                                ciphertext: base64UrlEncode(
                                    encrypted.ciphertext,
                                ),
                            },
                        }),
                    ).buffer,
                ) as Response,
            );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            // First call had cursor, second did not
            expect(fetchMock.mock.calls[0][0]).toContain('cursor=');
            expect(fetchMock.mock.calls[1][0]).not.toContain('cursor=');

            expect(messages).toHaveLength(1);
            expect(messages[0].text).toBe('Recovered message');

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

            // Live: key share + one message
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

            // Archive: key share (same) + older message
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
            // cbor-x reuses an internal buffer; copy to an independent ArrayBuffer
            const archiveCbor = new Uint8Array(archiveCborBytes).buffer;

            // Mock: live storeList
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [
                        `inbox/${toUserId}/live/msg-ks-001`,
                        `inbox/${toUserId}/live/msg-live-001`,
                    ],
                    next_cursor: '',
                }) as Response,
            );
            // Mock: live storeGet (key share)
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(keyShareEnvelope))
                        .buffer,
                ) as Response,
            );
            // Mock: live storeGet (message)
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(JSON.stringify(liveMsg)).buffer,
                ) as Response,
            );
            // Mock: archive storeList
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`inbox/${toUserId}/archive/2025-01-15-01ARCHIVEID`],
                    next_cursor: '',
                }) as Response,
            );
            // Mock: archive storeGet (CBOR blob)
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(archiveCbor) as Response,
            );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            // Both live and archived messages should be returned
            expect(messages).toHaveLength(2);
            const texts = messages.map((m) => m.text);
            expect(texts).toContain('Live message');
            expect(texts).toContain('Archived message');
            // Sorted by timestamp (archived is older)
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

            // Archive contains the same msg_id
            const archiveCborBytes = cborEncode([
                keyShareEnvelope,
                msgEnvelope,
            ]);
            const archiveCbor = new Uint8Array(archiveCborBytes).buffer;

            // Mock: live storeList
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
            // Mock: archive storeList
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`inbox/${toUserId}/archive/2025-01-15-01ARCHIVEID`],
                    next_cursor: '',
                }) as Response,
            );
            // Mock: archive storeGet
            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(archiveCbor) as Response,
            );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            // Should NOT have duplicates — only one message with that msg_id
            expect(messages).toHaveLength(1);
            expect(messages[0].id).toBe(sharedMsgId);

            sender.free();
            mgr.destroy();
        });

        it('returns empty when archive list fails', async () => {
            const mgr = await createSessionManager(wasm);

            // Mock: live storeList (empty)
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [],
                    next_cursor: '',
                }) as Response,
            );
            // Mock: archive storeList fails
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
    });

    describe('compactAfterRotation', () => {
        it('calls storeCompact with inbox cursor', async () => {
            // Pre-seed a cursor
            const prefix = `inbox/${fromUserId}/live/`;
            await saveSyncCursor(prefix, `${prefix}01LASTMSGID`);

            // Mock storeCompact response
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    archived: 5,
                    archive_key: `inbox/${fromUserId}/archive/2025-01-15-01ARCHIVEID`,
                }) as Response,
            );

            await compactAfterRotation(token, fromUserId);

            // Verify storeCompact was called with correct args
            const call = fetchMock.mock.calls[0];
            expect(call[0]).toBe('/v1/store/compact');
            const body = JSON.parse(call[1].body);
            expect(body.prefix).toBe(prefix);
            expect(body.up_to).toBe('01LASTMSGID');
        });

        it('skips compaction when no cursor exists', async () => {
            await compactAfterRotation(token, fromUserId);

            // No fetch calls should have been made
            expect(fetchMock).not.toHaveBeenCalled();
        });
    });
});
