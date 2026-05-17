import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    onAuthEvent,
    type RegisterRequest,
    register,
    resolve,
    storeGet,
    updateProfile,
} from './api';

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
