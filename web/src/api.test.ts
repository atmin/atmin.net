import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fetchMessages,
    type RegisterRequest,
    register,
    resolve,
    sendTextMessage,
} from './api';
import { base64UrlEncode, deriveKeys, generateBackupSecret } from './crypto';

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

describe('api - Message encryption/decryption', () => {
    const token = 'test-token';
    const fromUserId = '01TESTUSER123';
    const fromDeviceId = '01TESTDEVICE456';
    const toUserId = '01TESTUSER789';

    let _senderKeys: Awaited<ReturnType<typeof deriveKeys>>;
    let recipientKeys: Awaited<ReturnType<typeof deriveKeys>>;

    beforeEach(async () => {
        fetchMock.mockReset();

        // Generate keys for sender and recipient
        const senderSecret = generateBackupSecret();
        const recipientSecret = generateBackupSecret();

        _senderKeys = await deriveKeys(senderSecret);
        recipientKeys = await deriveKeys(recipientSecret);
    });

    describe('sendTextMessage', () => {
        it('encrypts and sends a text message', async () => {
            const messageText = 'Hello, encrypted world!';

            fetchMock.mockResolvedValueOnce(mockJsonResponse({}) as Response);

            await sendTextMessage(
                token,
                fromUserId,
                fromDeviceId,
                toUserId,
                recipientKeys.sharing.publicKeyBytes,
                messageText,
            );

            // Verify fetch was called
            expect(fetchMock).toHaveBeenCalledWith(
                expect.stringContaining('/v1/send'),
                expect.objectContaining({
                    method: 'POST',
                    headers: expect.objectContaining({
                        Authorization: `Bearer ${token}`,
                    }),
                }),
            );

            // Get the envelope from the fetch call
            const fetchCall = fetchMock.mock.calls[0];
            const body = JSON.parse(fetchCall[1].body);
            const envelope = body.envelopes[0];

            // Verify envelope structure
            expect(envelope).toMatchObject({
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                content_type: 'text/plain',
            });

            // Verify envelope has timestamp
            expect(envelope.timestamp).toBeTypeOf('number');
            expect(envelope.timestamp).toBeGreaterThan(0);

            // Verify payload is encrypted
            expect(envelope.payload).toHaveProperty('ephemeral_key');
            expect(envelope.payload).toHaveProperty('iv');
            expect(envelope.payload).toHaveProperty('ciphertext');

            // Verify we can decrypt the message
            const { eciesDecrypt, base64UrlDecode } = await import('./crypto');
            const decrypted = await eciesDecrypt(
                recipientKeys.sharing.privateKey,
                {
                    ephemeralKey: base64UrlDecode(
                        envelope.payload.ephemeral_key,
                    ),
                    iv: base64UrlDecode(envelope.payload.iv),
                    ciphertext: base64UrlDecode(envelope.payload.ciphertext),
                },
            );
            const decryptedText = new TextDecoder().decode(decrypted);
            expect(decryptedText).toBe(messageText);
        });

        it('throws error when API returns non-ok response', async () => {
            fetchMock.mockResolvedValueOnce({
                ok: false,
                status: 401,
                statusText: 'Unauthorized',
            } as Response);

            await expect(
                sendTextMessage(
                    token,
                    fromUserId,
                    fromDeviceId,
                    toUserId,
                    recipientKeys.sharing.publicKeyBytes,
                    'test message',
                ),
            ).rejects.toThrow();
        });
    });

    describe('fetchMessages', () => {
        it('fetches and decrypts messages from server', async () => {
            const messageText1 = 'First message';
            const messageText2 = 'Second message';
            const timestamp1 = Date.now() - 3600000; // 1 hour ago
            const timestamp2 = Date.now();

            // Create encrypted messages
            const { eciesEncrypt, base64UrlEncode } = await import('./crypto');

            const encrypted1 = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode(messageText1),
            );
            const encrypted2 = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode(messageText2),
            );

            const envelope1 = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-001',
                content_type: 'text/plain',
                timestamp: timestamp1,
                payload: {
                    ephemeral_key: base64UrlEncode(encrypted1.ephemeralKey),
                    iv: base64UrlEncode(encrypted1.iv),
                    ciphertext: base64UrlEncode(encrypted1.ciphertext),
                },
            };

            const envelope2 = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-002',
                content_type: 'text/plain',
                timestamp: timestamp2,
                payload: {
                    ephemeral_key: base64UrlEncode(encrypted2.ephemeralKey),
                    iv: base64UrlEncode(encrypted2.iv),
                    ciphertext: base64UrlEncode(encrypted2.ciphertext),
                },
            };

            // Mock storeList response
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [
                        `inbox/${toUserId}/live/msg-001`,
                        `inbox/${toUserId}/live/msg-002`,
                    ],
                    next_cursor: '',
                }) as Response,
            );

            // Mock storeGet responses for each message
            fetchMock
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(JSON.stringify(envelope1))
                            .buffer,
                    ) as Response,
                )
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(JSON.stringify(envelope2))
                            .buffer,
                    ) as Response,
                );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
            );

            // Verify messages were decrypted correctly
            expect(messages).toHaveLength(2);
            expect(messages[0]).toMatchObject({
                id: 'msg-001',
                fromUser: fromUserId,
                fromDevice: fromDeviceId,
                text: messageText1,
            });
            expect(messages[0].timestamp.getTime()).toBe(timestamp1);

            expect(messages[1]).toMatchObject({
                id: 'msg-002',
                text: messageText2,
            });
            expect(messages[1].timestamp.getTime()).toBe(timestamp2);
        });

        it('returns empty array when no messages exist', async () => {
            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({ keys: [], next_cursor: '' }) as Response,
            );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
            );

            expect(messages).toEqual([]);
        });

        it('skips messages that cannot be decrypted', async () => {
            const { eciesEncrypt } = await import('./crypto');

            const validMessage = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode('Valid message'),
            );

            const validEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-valid',
                content_type: 'text/plain',
                timestamp: Date.now(),
                payload: {
                    ephemeral_key: base64UrlEncode(validMessage.ephemeralKey),
                    iv: base64UrlEncode(validMessage.iv),
                    ciphertext: base64UrlEncode(validMessage.ciphertext),
                },
            };

            const invalidEnvelope = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-invalid',
                content_type: 'text/plain',
                timestamp: Date.now(),
                payload: {
                    ephemeral_key: 'invalid-key',
                    iv: 'invalid-iv',
                    ciphertext: 'invalid-ciphertext',
                },
            };

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [
                        `inbox/${toUserId}/live/msg-valid`,
                        `inbox/${toUserId}/live/msg-invalid`,
                    ],
                    next_cursor: '',
                }) as Response,
            );

            fetchMock
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(JSON.stringify(validEnvelope))
                            .buffer,
                    ) as Response,
                )
                .mockResolvedValueOnce(
                    mockArrayBufferResponse(
                        new TextEncoder().encode(
                            JSON.stringify(invalidEnvelope),
                        ).buffer,
                    ) as Response,
                );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
            );

            // Should only get the valid message, invalid one is skipped
            expect(messages).toHaveLength(1);
            expect(messages[0].id).toBe('msg-valid');
        });

        it('handles messages without timestamps (backward compatibility)', async () => {
            const { eciesEncrypt } = await import('./crypto');

            const encrypted = await eciesEncrypt(
                recipientKeys.sharing.publicKey,
                new TextEncoder().encode('Old message'),
            );

            const envelopeWithoutTimestamp = {
                v: 1,
                to_user: toUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: 'msg-old',
                content_type: 'text/plain',
                // No timestamp field
                payload: {
                    ephemeral_key: base64UrlEncode(encrypted.ephemeralKey),
                    iv: base64UrlEncode(encrypted.iv),
                    ciphertext: base64UrlEncode(encrypted.ciphertext),
                },
            };

            fetchMock.mockResolvedValueOnce(
                mockJsonResponse({
                    keys: [`inbox/${toUserId}/live/msg-old`],
                    next_cursor: '',
                }) as Response,
            );

            fetchMock.mockResolvedValueOnce(
                mockArrayBufferResponse(
                    new TextEncoder().encode(
                        JSON.stringify(envelopeWithoutTimestamp),
                    ).buffer,
                ) as Response,
            );

            const messages = await fetchMessages(
                token,
                toUserId,
                recipientKeys.sharing.privateKey,
            );

            expect(messages).toHaveLength(1);
            expect(messages[0].text).toBe('Old message');
            expect(messages[0].timestamp.getTime()).toBe(0); // Falls back to epoch 0
        });
    });
});

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
