import { IDBKeyRange as FakeIDBKeyRange, IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    MegolmInbound,
    MegolmOutbound,
} from '../crypto/pkg-node/atmin_crypto.js';
import {
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

    beforeEach(async () => {
        fetchMock.mockReset();
        globalThis.indexedDB = new IDBFactory();
        globalThis.IDBKeyRange = FakeIDBKeyRange;

        const recipientSecret = generateBackupSecret();
        recipientKeys = await deriveKeys(recipientSecret);
    });

    afterEach(async () => {
        await clearOutboundSession();
        await clearInboundSessions();
        await clearKeyShares();
    });

    describe('sendTextMessage', () => {
        it('produces key_share + message envelopes on first send', async () => {
            const mgr = createSessionManager(wasm);
            fetchMock.mockResolvedValueOnce(mockJsonResponse({}) as Response);

            await sendTextMessage(
                token,
                fromUserId,
                fromDeviceId,
                toUserId,
                recipientKeys.sharing.publicKeyBytes,
                'Hello Megolm!',
                mgr,
            );

            const fetchCall = fetchMock.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);

            // key_share + message to recipient + self-copy = 3 envelopes
            expect(body.envelopes).toHaveLength(3);

            const keyShare = body.envelopes.find(
                (e: { content_type: string }) =>
                    e.content_type === 'megolm.key_share',
            );
            const messages = body.envelopes.filter(
                (e: { content_type: string }) =>
                    e.content_type === 'megolm.message',
            );

            expect(keyShare).toBeDefined();
            expect(keyShare.to_user).toBe(toUserId);
            expect(keyShare.payload).toHaveProperty('ephemeral_key');

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
            const mgr = createSessionManager(wasm);

            fetchMock.mockResolvedValueOnce(mockJsonResponse({}) as Response);
            await sendTextMessage(
                token,
                fromUserId,
                fromDeviceId,
                toUserId,
                recipientKeys.sharing.publicKeyBytes,
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
            const mgr = createSessionManager(wasm);

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
                timestamp: Date.now() - 1000,
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
                timestamp: Date.now(),
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
            const mgr = createSessionManager(wasm);
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
                timestamp: Date.now(),
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
            const mgr = createSessionManager(wasm);

            const messageEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-unknown',
                content_type: 'megolm.message',
                timestamp: Date.now(),
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
});
