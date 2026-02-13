export class APIError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
    ) {
        super(message);
    }
}

async function request<T>(
    method: string,
    path: string,
    opts?: { body?: unknown; token?: string },
): Promise<T> {
    const headers: Record<string, string> = {};
    if (opts?.token) headers.Authorization = `Bearer ${opts.token}`;
    if (opts?.body) headers['Content-Type'] = 'application/json';

    const res = await fetch(path, {
        method,
        headers,
        body: opts?.body ? JSON.stringify(opts.body) : undefined,
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({
            error: 'unknown',
            message: res.statusText,
        }));
        throw new APIError(res.status, err.error, err.message);
    }

    if (
        res.status === 200 &&
        res.headers.get('content-type')?.includes('json')
    ) {
        return res.json();
    }
    return undefined as T;
}

// --- Types ---

export interface RegisterRequest {
    device_label: string;
    auth_public_key: string;
    sharing_public_key: string;
}

export interface RegisterResponse {
    user_id: string;
    device_id: string;
    token: string;
    invite_handle: string;
}

export interface ResolveResponse {
    user_id: string;
    sharing_public_key: string;
}

export interface Envelope {
    v: number;
    to_user: string;
    from_user: string;
    from_device: string;
    msg_id: string;
    content_type: string;
    payload: Record<string, string>;
}

export interface StoreListResponse {
    keys: string[];
    next_cursor: string;
}

export interface CompactResponse {
    archived: number;
    archive_key: string;
}

// --- API functions ---

export function register(req: RegisterRequest): Promise<RegisterResponse> {
    return request('POST', '/v1/register', { body: req });
}

export function resolve(handle: string): Promise<ResolveResponse> {
    return request('GET', `/v1/resolve/${encodeURIComponent(handle)}`);
}

export function send(token: string, envelopes: Envelope[]): Promise<void> {
    return request('POST', '/v1/send', { token, body: { envelopes } });
}

export function storeList(
    token: string,
    prefix: string,
    cursor?: string,
): Promise<StoreListResponse> {
    const params = new URLSearchParams({ prefix });
    if (cursor) params.set('cursor', cursor);
    return request('GET', `/v1/store/list?${params}`, { token });
}

export function storeGet(token: string, key: string): Promise<ArrayBuffer> {
    return fetch(`/v1/store/object?${new URLSearchParams({ key })}`, {
        headers: { Authorization: `Bearer ${token}` },
    }).then((res) => {
        if (!res.ok)
            throw new APIError(res.status, 'fetch_error', res.statusText);
        return res.arrayBuffer();
    });
}

export function storePresign(
    token: string,
    key: string,
    bytes: number,
): Promise<{ presigned_url: string }> {
    return request('POST', '/v1/store/presign', {
        token,
        body: { key, bytes },
    });
}

export function storeCompact(
    token: string,
    prefix: string,
    upTo: string,
): Promise<CompactResponse> {
    return request('POST', '/v1/store/compact', {
        token,
        body: { prefix, up_to: upTo },
    });
}
