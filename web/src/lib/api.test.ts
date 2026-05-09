import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MegolmInbound,
    MegolmOutbound,
} from '../../crypto/pkg-node/atmin_crypto.js';
import {
    fetchMessages,
    type RegisterRequest,
    register,
    resolve,
    sendTextMessage,
    setOnDeviceRevoked,
    setOnUnauthorized,
    storeGet,
    updateProfile,
} from './api';
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
import type { WasmModule } from './wasm';

// Setup fetch mock — default resolves to an ok response so fire-and-forget
// calls (e.g. compaction) that outlive explicit mockResolvedValueOnce() don't
// blow up with "Cannot read properties of undefined".
const fetchMock = vi.fn();
globalThis.fetch = fetchMock as typeof fetch;

function resetFetchMock() {
    fetchMock.mockReset();
    // Shape satisfies StoreListResponse (for storeList) and is harmless for
    // fire-and-forget storeCompact calls that go through request().
    fetchMock.mockResolvedValue(
        mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
    );
}
resetFetchMock();

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
        resetFetchMock();
    });

    it('successfully registers a new user with valid keys', async () => {
        const mockResponse = {
            user_id: '01NEWUSER123',
            device_id: '01NEWDEVICE456',
            token: 'new-auth-token-abc123',
            handle: 'copper-falcon',
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
        expect(result.handle).toBe('copper-falcon');
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

describe('api - updateProfile()', () => {
    beforeEach(() => {
        resetFetchMock();
    });

    it('sends PUT /v1/profile with display_name and auth token', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: true,
            status: 200,
            headers: { get: () => null },
        } as unknown as Response);

        await updateProfile('test-token', { display_name: 'Alice W.' });

        expect(fetchMock).toHaveBeenCalledWith(
            '/v1/profile',
            expect.objectContaining({
                method: 'PUT',
                headers: expect.objectContaining({
                    Authorization: 'Bearer test-token',
                    'Content-Type': 'application/json',
                }),
            }),
        );

        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body).toEqual({ display_name: 'Alice W.' });
    });

    it('throws APIError on 400 (bad request)', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 400,
            statusText: 'Bad Request',
            json: async () => ({
                error: 'bad_request',
                message: 'At least one field required',
            }),
        } as Response);

        await expect(updateProfile('test-token', {})).rejects.toMatchObject({
            status: 400,
            code: 'bad_request',
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

            // Pre-seed a cursor to simulate a previous sync
            const prefix = `inbox/${toUserId}/live/`;
            await saveSyncCursor(prefix, `${prefix}msg-001`);

            // Create Megolm sender and key share
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

            // Second sync: server returns only new messages
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

            sender.free();
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

            // Create Megolm sender and key share
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

            // First call had cursor, second did not
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

        it('persists archive cursor after fetching archives', async () => {
            const { encode: cborEncode } = await import('cbor-x');
            const mgr = await createSessionManager(wasm);
            const archivePrefix = `inbox/${toUserId}/archive/`;
            const archiveKey = `${archivePrefix}2026-01-15-01ARCHIVEID1`;

            // No live messages
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
            );
            // Archive storeList returns one key
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [archiveKey],
                    next_cursor: '',
                }) as Response,
            );
            // Archive storeGet returns empty CBOR array
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

            // Pre-seed the archive cursor (simulate a previous sync)
            await saveSyncCursor(archivePrefix, priorArchiveKey);

            // No live messages
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
            );
            // Archive storeList: default mock handles it (returns empty, no new archives)

            await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
                mgr,
            );

            // call 0 = live storeList, call 1 = archive storeList with cursor
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

            // Pre-seed a stale archive cursor
            await saveSyncCursor(archivePrefix, staleKey);

            // No live messages
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
            );
            // Archive storeList with stale cursor → server error
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
            // Fallback archive storeList (no cursor) → success
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [freshArchiveKey],
                    next_cursor: '',
                }) as Response,
            );
            // Archive storeGet → empty CBOR
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

            // call 0 = live storeList
            // call 1 = archive storeList with stale cursor
            // call 2 = archive storeList fallback (no cursor)
            expect(fetchMock.mock.calls[1][0]).toContain('cursor=');
            expect(fetchMock.mock.calls[2][0]).not.toContain('cursor=');

            // Cursor updated to the successfully fetched archive key
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

            // Mock: live storeList
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [
                        `inbox/${toUserId}/live/msg-ks-compact`,
                        `inbox/${toUserId}/live/msg-compact-001`,
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
                    new TextEncoder().encode(JSON.stringify(messageEnvelope))
                        .buffer,
                ) as Response,
            );
            // Mock: archive storeList (empty)
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [],
                    next_cursor: '',
                }) as Response,
            );
            // Mock: storeCompact (fire-and-forget)
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

            // Verify storeCompact was called with correct args
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

            // Mock: live storeList returns empty
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

            // No compact call should have been made
            const compactCall = fetchMock.mock.calls.find(
                (call: unknown[]) => call[0] === '/v1/store/compact',
            );
            expect(compactCall).toBeUndefined();

            mgr.destroy();
        });
    });
});

describe('api - device revocation', () => {
    beforeEach(() => {
        resetFetchMock();
    });

    afterEach(() => {
        setOnDeviceRevoked(null);
    });

    it('calls onDeviceRevoked callback on 403 device_revoked', async () => {
        const onRevoked = vi.fn();
        setOnDeviceRevoked(onRevoked);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            json: async () => ({
                error: 'device_revoked',
                message: 'Device has been revoked',
            }),
        } as Response);

        await expect(resolve('any-handle')).rejects.toMatchObject({
            status: 403,
            code: 'device_revoked',
        });

        expect(onRevoked).toHaveBeenCalledOnce();
    });

    it('does not call onDeviceRevoked on other 403 errors', async () => {
        const onRevoked = vi.fn();
        setOnDeviceRevoked(onRevoked);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            json: async () => ({
                error: 'insufficient_permissions',
                message: 'Not allowed',
            }),
        } as Response);

        await expect(resolve('any-handle')).rejects.toMatchObject({
            status: 403,
            code: 'insufficient_permissions',
        });

        expect(onRevoked).not.toHaveBeenCalled();
    });

    it('does not throw when no callback is registered', async () => {
        setOnDeviceRevoked(null);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            json: async () => ({
                error: 'device_revoked',
                message: 'Device has been revoked',
            }),
        } as Response);

        await expect(resolve('any-handle')).rejects.toMatchObject({
            status: 403,
            code: 'device_revoked',
        });
    });
});

describe('api - unauthorized (401)', () => {
    beforeEach(() => {
        resetFetchMock();
    });

    afterEach(() => {
        setOnUnauthorized(null);
    });

    it('calls onUnauthorized callback on 401', async () => {
        const onUnauth = vi.fn();
        setOnUnauthorized(onUnauth);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({
                error: 'unauthorized',
                message: 'Token invalid',
            }),
        } as Response);

        await expect(resolve('any-handle')).rejects.toMatchObject({
            status: 401,
        });

        expect(onUnauth).toHaveBeenCalledOnce();
    });

    it('does not call onUnauthorized on other 4xx errors', async () => {
        const onUnauth = vi.fn();
        setOnUnauthorized(onUnauth);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            json: async () => ({
                error: 'forbidden',
                message: 'Not allowed',
            }),
        } as Response);

        await expect(resolve('any-handle')).rejects.toMatchObject({
            status: 403,
        });

        expect(onUnauth).not.toHaveBeenCalled();
    });

    it('does not throw when no callback is registered', async () => {
        setOnUnauthorized(null);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({
                error: 'unauthorized',
                message: 'Token invalid',
            }),
        } as Response);

        await expect(resolve('any-handle')).rejects.toMatchObject({
            status: 401,
        });
    });

    it('calls onUnauthorized from storeGet() path', async () => {
        const onUnauth = vi.fn();
        setOnUnauthorized(onUnauth);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({
                error: 'unauthorized',
                message: 'Token invalid',
            }),
        } as Response);

        await expect(storeGet('bad-token', 'some/key')).rejects.toMatchObject({
            status: 401,
        });

        expect(onUnauth).toHaveBeenCalledOnce();
    });
});

describe('api - key-share backup', () => {
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

        // backupSessionKey is fire-and-forget so the presign call races with
        // the archive storeList call. Use URL-based routing to avoid ordering
        // issues with mockResolvedValueOnce.
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

        // backupSessionKey is fire-and-forget; wait for presign call to settle
        await vi.waitFor(() => {
            const done = fetchMock.mock.calls.some(
                (call) => (call[0] as string) === '/v1/store/presign',
            );
            if (!done) throw new Error('storePresign not yet called');
        });

        // Find the storePresign call
        const presignCall = fetchMock.mock.calls.find(
            (call) => (call[0] as string) === '/v1/store/presign',
        );
        expect(presignCall).toBeDefined();
        const presignBody = JSON.parse(presignCall![1].body as string);
        expect(presignBody.key).toBe(
            `keys/${userId}/live/${sender.session_id}`,
        );

        // Find the PUT to presigned URL and verify the body decrypts to the session key
        const putCall = fetchMock.mock.calls.find(
            (call) => (call[0] as string) === presignedUrl,
        );
        expect(putCall).toBeDefined();
        const putBody = JSON.parse(
            new TextDecoder().decode(putCall![1].body as Uint8Array),
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

        // First fetch: key share is new → should trigger backup
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

        const presignCountAfterFirst = fetchMock.mock.calls.filter(
            (call) => (call[0] as string) === '/v1/store/presign',
        ).length;
        expect(presignCountAfterFirst).toBe(1);

        resetFetchMock();

        // Second fetch: same key share → session already in cache → no backup
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

        const presignCountAfterSecond = fetchMock.mock.calls.filter(
            (call) => (call[0] as string) === '/v1/store/presign',
        ).length;
        expect(presignCountAfterSecond).toBe(0);

        sender.free();
        mgr.destroy();
    });
});
