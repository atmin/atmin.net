import { ulid } from 'ulid';
import type { Envelope } from './envelope';

export class APIError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
    ) {
        super(message);
    }
}

type AuthEvent = 'device_revoked' | 'unauthorized';
const authEvents = new EventTarget();

export function onAuthEvent(type: AuthEvent, cb: () => void): () => void {
    const handler = () => cb();
    authEvents.addEventListener(type, handler);
    return () => authEvents.removeEventListener(type, handler);
}

function emitAuth(type: AuthEvent): void {
    authEvents.dispatchEvent(new Event(type));
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
        if (res.status === 403 && err.error === 'device_revoked')
            emitAuth('device_revoked');
        if (res.status === 401) emitAuth('unauthorized');
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
    handle: string;
}

export interface ResolveResponse {
    user_id: string;
    sharing_public_key: string;
    display_name?: string;
    avatar_url?: string;
}

export interface ProfileUpdateRequest {
    display_name?: string;
    avatar_url?: string;
}

export interface StoreListResponse {
    keys: string[];
    next_cursor: string;
}

export interface CompactResponse {
    archived: number;
    archive_key: string;
}

export interface AddDeviceRequest {
    user_id: string;
    device_label: string;
    auth_proof: {
        payload: {
            user_id: string;
            device_id: string;
            timestamp: string;
        };
        signature: string;
    };
}

export interface AddDeviceResponse {
    device_id: string;
    token: string;
}

export interface RevokeDeviceRequest {
    device_id: string;
    auth_proof: {
        payload: {
            user_id: string;
            device_id: string;
            timestamp: string;
        };
        signature: string;
    };
}

export interface DeviceInfo {
    device_id: string;
    device_label: string;
    created_at: string;
}

// --- API functions ---

export function register(req: RegisterRequest): Promise<RegisterResponse> {
    return request('POST', '/v1/register', { body: req });
}

export function addDevice(req: AddDeviceRequest): Promise<AddDeviceResponse> {
    return request('POST', '/v1/devices', { body: req });
}

export async function listDevices(
    token: string,
    userId: string,
): Promise<DeviceInfo[]> {
    const prefix = `users/${userId}/devices/`;
    const listRes = await storeList(token, prefix);
    const devices: DeviceInfo[] = [];
    for (const key of listRes.keys) {
        const blob = await storeGet(token, key);
        const device = JSON.parse(new TextDecoder().decode(blob)) as DeviceInfo;
        devices.push(device);
    }
    return devices;
}

export function deleteDevice(token: string): Promise<void> {
    return request('DELETE', '/v1/devices', { token });
}

export function revokeDevice(
    token: string,
    req: RevokeDeviceRequest,
): Promise<void> {
    return request('POST', '/v1/devices/revoke', { token, body: req });
}

export function updateProfile(
    token: string,
    req: ProfileUpdateRequest,
): Promise<void> {
    return request('PUT', '/v1/profile', { token, body: req });
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

export async function storeGet(
    token: string,
    key: string,
): Promise<ArrayBuffer> {
    const res = await fetch(
        `/v1/store/object?${new URLSearchParams({ key })}`,
        { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) {
        const err = await res.json().catch(() => ({
            error: 'fetch_error',
            message: res.statusText,
        }));
        if (res.status === 403 && err.error === 'device_revoked')
            emitAuth('device_revoked');
        if (res.status === 401) emitAuth('unauthorized');
        throw new APIError(res.status, err.error, err.message);
    }
    return res.arrayBuffer();
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

// --- Media upload/download ---

import type { EncryptedMedia } from './media';

export class NotFoundError extends Error {
    constructor() {
        super('not found');
        this.name = 'NotFoundError';
    }
}

export class NetworkError extends Error {
    constructor(msg = 'network error') {
        super(msg);
        this.name = 'NetworkError';
    }
}

export const MEDIA_FETCH_TIMEOUT_MS = 60_000;

async function putWithRetry(
    url: string,
    body: Uint8Array,
    abort?: AbortSignal,
): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            const res = await fetch(url, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: body as BodyInit,
                signal: abort,
            });
            if (res.ok) return;
            if (res.status < 500) {
                throw new APIError(
                    res.status,
                    'upload_failed',
                    `PUT failed: ${res.status}`,
                );
            }
            lastErr = new APIError(
                res.status,
                'upload_failed',
                `PUT failed: ${res.status}`,
            );
        } catch (e) {
            if (e instanceof APIError) throw e;
            if (abort?.aborted) throw e;
            lastErr = e;
        }
    }
    throw lastErr;
}

export async function uploadMedia(
    token: string,
    userId: string,
    encrypted: EncryptedMedia,
    abort?: AbortSignal,
): Promise<{ url: string; mediaUlid: string }> {
    const mediaUlid = ulid();
    const key = `media/${userId}/${mediaUlid}`;

    const { presigned_url } = await storePresign(
        token,
        key,
        encrypted.ciphertext.length,
    );
    await putWithRetry(presigned_url, encrypted.ciphertext, abort);
    return { url: key, mediaUlid };
}

export async function fetchMedia(
    token: string,
    url: string,
    abort: AbortSignal,
): Promise<Uint8Array> {
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    abort.addEventListener('abort', onAbort);
    const timer = setTimeout(() => ctl.abort(), MEDIA_FETCH_TIMEOUT_MS);

    try {
        const res = await fetch(
            `/v1/store/object?${new URLSearchParams({ key: url })}`,
            {
                headers: { Authorization: `Bearer ${token}` },
                signal: ctl.signal,
            },
        );
        if (res.status === 404) throw new NotFoundError();
        if (!res.ok) throw new NetworkError(`status ${res.status}`);
        const buf = await res.arrayBuffer();
        return new Uint8Array(buf);
    } catch (e) {
        if (e instanceof NotFoundError) throw e;
        if (e instanceof NetworkError) throw e;
        throw new NetworkError(
            e instanceof Error ? e.message : 'network error',
        );
    } finally {
        clearTimeout(timer);
        abort.removeEventListener('abort', onAbort);
    }
}
