import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    APIError,
    KeyVersionStaleError,
    onAuthEvent,
    type RegisterRequest,
    type RotateKeysRequest,
    register,
    resolve,
    rotateKeys,
    send,
    storeGet,
    updateProfile,
} from './api';
import type { Envelope } from './envelope';

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

describe('api - resolve()', () => {
    it('resolves a valid handle to a live discriminated-union result', async () => {
        const mockResponse = {
            user_id: '01TESTUSER123',
            sharing_public_key: 'base64url-encoded-public-key',
        };

        fetchMock.mockResolvedValueOnce(
            mockJsonResponse(mockResponse) as Response,
        );

        const result = await resolve('alice-test');

        expect(fetchMock).toHaveBeenCalledWith('/v1/resolve/alice-test');

        expect(result.status).toBe('live');
        if (result.status !== 'live') throw new Error('discriminator narrow');
        expect(result.user_id).toBe('01TESTUSER123');
        expect(result.sharing_public_key).toBe('base64url-encoded-public-key');
    });

    it('returns { status: "not_found" } on 404', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 404,
            statusText: 'Not Found',
            json: async () => ({ error: 'not_found' }),
        } as Response);

        const result = await resolve('nobody');
        expect(result).toEqual({ status: 'not_found' });
    });

    it('returns { status: "released", ... } on 410 with cooldown timestamps', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 410,
            statusText: 'Gone',
            json: async () => ({
                error: 'released',
                released_at: '2026-05-01T00:00:00Z',
                available_at: '2026-05-31T00:00:00Z',
            }),
        } as Response);

        const result = await resolve('rip-handle');
        expect(result).toEqual({
            status: 'released',
            released_at: '2026-05-01T00:00:00Z',
            available_at: '2026-05-31T00:00:00Z',
        });
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
        );
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

        expect(fetchMock).toHaveBeenCalledWith('/v1/resolve/');
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
            handle: 'alice-test',
            device_label: 'My Phone',
            auth_public_key: 'auth-key-base64url',
            sharing_public_key: 'sharing-key-base64url',
        };

        const result = await register(request);

        expect(fetchMock).toHaveBeenCalledWith(
            '/v1/register',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    'Content-Type': 'application/json',
                }),
            }),
        );

        const fetchCall = fetchMock.mock.calls[0];
        const body = JSON.parse(fetchCall[1].body);
        expect(body).toEqual(request);

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
            handle: 'alice-test',
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
            handle: 'alice-test',
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
            handle: 'alice-test',
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
            handle: 'alice-test',
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
            handle: 'alice-test',
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

describe('api - device revocation', () => {
    let unsub: (() => void) | undefined;

    beforeEach(() => {
        resetFetchMock();
    });

    afterEach(() => {
        unsub?.();
        unsub = undefined;
    });

    it('calls device_revoked listeners on 403 device_revoked', async () => {
        const onRevoked = vi.fn();
        unsub = onAuthEvent('device_revoked', onRevoked);

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

    it('notifies two device_revoked listeners independently', async () => {
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        const u1 = onAuthEvent('device_revoked', cb1);
        const u2 = onAuthEvent('device_revoked', cb2);

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

        expect(cb1).toHaveBeenCalledOnce();
        expect(cb2).toHaveBeenCalledOnce();
        u1();
        u2();
    });

    it('unsubscribe stops only its own callback', async () => {
        const cb1 = vi.fn();
        const cb2 = vi.fn();
        const u1 = onAuthEvent('device_revoked', cb1);
        unsub = onAuthEvent('device_revoked', cb2);
        u1();

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

        expect(cb1).not.toHaveBeenCalled();
        expect(cb2).toHaveBeenCalledOnce();
    });

    it('does not call device_revoked listener on other 403 errors', async () => {
        const onRevoked = vi.fn();
        unsub = onAuthEvent('device_revoked', onRevoked);

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

    it('does not throw when no listener is registered', async () => {
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
    let unsub: (() => void) | undefined;

    beforeEach(() => {
        resetFetchMock();
    });

    afterEach(() => {
        unsub?.();
        unsub = undefined;
    });

    it('calls unauthorized listeners on 401', async () => {
        const onUnauth = vi.fn();
        unsub = onAuthEvent('unauthorized', onUnauth);

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

    it('does not call unauthorized listener on other 4xx errors', async () => {
        const onUnauth = vi.fn();
        unsub = onAuthEvent('unauthorized', onUnauth);

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

    it('does not throw when no listener is registered', async () => {
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

    it('calls unauthorized listener from storeGet() path', async () => {
        const onUnauth = vi.fn();
        unsub = onAuthEvent('unauthorized', onUnauth);

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

describe('api - key_version_stale event', () => {
    let unsub: (() => void) | undefined;

    beforeEach(() => {
        resetFetchMock();
    });

    afterEach(() => {
        unsub?.();
        unsub = undefined;
    });

    it('emits key_version_stale on 401 key_version_stale (request path)', async () => {
        const onStale = vi.fn();
        const onUnauth = vi.fn();
        unsub = onAuthEvent('key_version_stale', onStale);
        const unsubUnauth = onAuthEvent('unauthorized', onUnauth);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({
                error: 'key_version_stale',
                message: 'stale',
                current: 4,
            }),
        } as Response);

        await expect(resolve('any-handle')).rejects.toBeInstanceOf(
            KeyVersionStaleError,
        );

        expect(onStale).toHaveBeenCalledOnce();
        // Generic unauthorized listeners must NOT fire — staleness has its
        // own remediation path and would otherwise double-trigger cleanup.
        expect(onUnauth).not.toHaveBeenCalled();
        unsubUnauth();
    });

    it('emits key_version_stale from storeGet() path too', async () => {
        const onStale = vi.fn();
        unsub = onAuthEvent('key_version_stale', onStale);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({
                error: 'key_version_stale',
                message: 'stale',
                current: 4,
            }),
        } as Response);

        await expect(
            storeGet('stale-token', 'some/key'),
        ).rejects.toBeInstanceOf(KeyVersionStaleError);

        expect(onStale).toHaveBeenCalledOnce();
    });

    it('emits key_version_stale on 409 key_version_stale (race on rotate-keys)', async () => {
        const onStale = vi.fn();
        unsub = onAuthEvent('key_version_stale', onStale);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 409,
            statusText: 'Conflict',
            json: async () => ({
                error: 'key_version_stale',
                message: 'race',
                current: 3,
            }),
        } as Response);

        await expect(resolve('any-handle')).rejects.toBeInstanceOf(
            KeyVersionStaleError,
        );

        expect(onStale).toHaveBeenCalledOnce();
    });

    it('does NOT emit key_version_stale on a generic 401', async () => {
        const onStale = vi.fn();
        unsub = onAuthEvent('key_version_stale', onStale);

        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({
                error: 'unauthorized',
                message: 'no token',
            }),
        } as Response);

        await expect(resolve('any-handle')).rejects.toMatchObject({
            status: 401,
        });

        expect(onStale).not.toHaveBeenCalled();
    });
});

describe('api - rotateKeys()', () => {
    const baseReq: RotateKeysRequest = {
        request_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        key_version: 2,
        auth_public_key: 'newAuthPub',
        sharing_public_key: 'newSharePub',
        salt: 'newSalt',
        kdf: { type: 'argon2id', m: 65536, t: 3, p: 1 },
        continuity_signature: 'sigSigSig',
    };

    beforeEach(() => {
        fetchMock.mockReset();
    });

    it('POSTs the body with bearer token and returns the new token + kv', async () => {
        fetchMock.mockResolvedValueOnce(
            mockJsonResponse({
                token: 'NEW_TOKEN',
                key_version: 2,
            }) as Response,
        );
        const res = await rotateKeys('OLD_TOKEN', baseReq);

        expect(res).toEqual({ token: 'NEW_TOKEN', key_version: 2 });
        expect(fetchMock).toHaveBeenCalledWith(
            '/v1/rotate-keys',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({
                    Authorization: 'Bearer OLD_TOKEN',
                    'Content-Type': 'application/json',
                }),
                body: JSON.stringify(baseReq),
            }),
        );
    });

    it('throws KeyVersionStaleError on 401 key_version_stale with current', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 401,
            statusText: 'Unauthorized',
            json: async () => ({
                error: 'key_version_stale',
                message: 'stale',
                current: 3,
            }),
        } as Response);

        let caught: unknown;
        try {
            await rotateKeys('OLD', baseReq);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(KeyVersionStaleError);
        expect((caught as KeyVersionStaleError).current).toBe(3);
    });

    it('throws KeyVersionStaleError on 409 key_version_stale (race lost)', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 409,
            statusText: 'Conflict',
            json: async () => ({
                error: 'key_version_stale',
                message: 'race',
                current: 2,
            }),
        } as Response);

        let caught: unknown;
        try {
            await rotateKeys('OLD', baseReq);
        } catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(KeyVersionStaleError);
        expect((caught as KeyVersionStaleError).current).toBe(2);
    });

    it('throws APIError on 403 bad_continuity', async () => {
        fetchMock.mockResolvedValueOnce({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            json: async () => ({
                error: 'bad_continuity',
                message: 'sig fail',
            }),
        } as Response);

        await expect(rotateKeys('OLD', baseReq)).rejects.toMatchObject({
            status: 403,
            code: 'bad_continuity',
        });
    });

    it('a retry with the same request_id passes the same id on the wire', async () => {
        // First attempt: network failure. Second attempt: success.
        // The caller is responsible for retry; the wrapper just forwards
        // the body unchanged, so both calls must carry the same request_id.
        fetchMock
            .mockRejectedValueOnce(new Error('network'))
            .mockResolvedValueOnce(
                mockJsonResponse({ token: 'T', key_version: 2 }) as Response,
            );

        try {
            await rotateKeys('OLD', baseReq);
        } catch {
            // expected
        }
        const res = await rotateKeys('OLD', baseReq);
        expect(res.key_version).toBe(2);

        const body1 = JSON.parse(
            String((fetchMock.mock.calls[0][1] as RequestInit).body),
        );
        const body2 = JSON.parse(
            String((fetchMock.mock.calls[1][1] as RequestInit).body),
        );
        expect(body1.request_id).toBe(body2.request_id);
    });
});

describe('api - send() idempotent retry', () => {
    const envelopes = [
        {
            to_user: 'U_BOB',
            from_user: 'U_ALICE',
            from_device: 'D1',
            msg_id: '01MSGAAA',
        },
    ] as unknown as Envelope[];

    function errResponse(status: number): Response {
        return {
            ok: false,
            status,
            statusText: 'err',
            headers: { get: () => null },
            json: async () => ({ error: 'internal', message: 'boom' }),
        } as unknown as Response;
    }
    function okResponse(): Response {
        return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            json: async () => ({}),
        } as unknown as Response;
    }

    it('retries a transient 5xx then succeeds, reusing the same envelopes', async () => {
        fetchMock.mockReset();
        fetchMock
            .mockResolvedValueOnce(errResponse(502))
            .mockResolvedValueOnce(okResponse());

        await send('tok', envelopes);

        expect(fetchMock).toHaveBeenCalledTimes(2);
        // Both attempts carry the identical body — same msg_id, so the
        // server's per-msg_id overwrite cannot produce a duplicate.
        const b1 = String((fetchMock.mock.calls[0][1] as RequestInit).body);
        const b2 = String((fetchMock.mock.calls[1][1] as RequestInit).body);
        expect(b1).toBe(b2);
        expect(JSON.parse(b1).envelopes[0].msg_id).toBe('01MSGAAA');
    });

    it('retries a network error (fetch rejects) then succeeds', async () => {
        fetchMock.mockReset();
        fetchMock
            .mockRejectedValueOnce(new TypeError('network down'))
            .mockResolvedValueOnce(okResponse());

        await send('tok', envelopes);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fails fast on a 4xx (no retry)', async () => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue({
            ok: false,
            status: 403,
            statusText: 'Forbidden',
            json: async () => ({ error: 'forbidden', message: 'no' }),
        } as unknown as Response);

        await expect(send('tok', envelopes)).rejects.toBeInstanceOf(APIError);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('gives up after the attempt budget on persistent 5xx', async () => {
        fetchMock.mockReset();
        fetchMock.mockResolvedValue(errResponse(503));

        await expect(send('tok', envelopes)).rejects.toBeTruthy();
        expect(fetchMock).toHaveBeenCalledTimes(3);
    });
});
