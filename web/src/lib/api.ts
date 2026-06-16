import { ulid } from 'ulid';
import type { KdfParams } from './crypto';
import type { Envelope } from './envelope';
import { path } from './paths';

export class APIError extends Error {
    constructor(
        public status: number,
        public code: string,
        message: string,
    ) {
        super(message);
    }
}

// KeyVersionStaleError is the typed reaction to `key_version_stale` from
// either the middleware (401: this device's token was superseded by a
// rotation on another device — the caller's expected reaction is a forced
// re-login) or the rotate-keys handler (409: the request's key_version
// didn't advance from the current one — another rotation already
// happened). The `.current` field tells the client what to do: re-login
// at `current`, or re-derive at `current+1` and retry the rotation.
export class KeyVersionStaleError extends Error {
    constructor(public current: number) {
        super('key_version_stale');
        this.name = 'KeyVersionStaleError';
    }
}

type AuthEvent = 'device_revoked' | 'unauthorized' | 'key_version_stale';
const authEvents = new EventTarget();

export function onAuthEvent(type: AuthEvent, cb: () => void): () => void {
    const handler = () => cb();
    authEvents.addEventListener(type, handler);
    return () => authEvents.removeEventListener(type, handler);
}

function emitAuth(type: AuthEvent): void {
    authEvents.dispatchEvent(new Event(type));
}

// Shared between request() and storeGet() so both API entry points
// classify error responses identically. Always throws.
async function throwForErrorResponse(res: Response): Promise<never> {
    const err = await res.json().catch(() => ({
        error: 'unknown',
        message: res.statusText,
    }));
    if (err.error === 'key_version_stale') {
        // Emit before throw so global subscribers (useSession, SSE)
        // can clear local state even when the immediate caller doesn't
        // catch the typed error. rotateKeys catches it locally to
        // distinguish 401 (forced re-login) from 409 (race-lost retry).
        emitAuth('key_version_stale');
        throw new KeyVersionStaleError(
            typeof err.current === 'number' ? err.current : -1,
        );
    }
    if (res.status === 403 && err.error === 'device_revoked')
        emitAuth('device_revoked');
    else if (res.status === 401) emitAuth('unauthorized');
    throw new APIError(res.status, err.error, err.message);
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

    if (!res.ok) await throwForErrorResponse(res);

    if (
        res.status === 200 &&
        res.headers.get('content-type')?.includes('json')
    ) {
        return res.json();
    }
    return undefined as T;
}

// --- Types ---

// Registration proof-of-work (ADR-0020). The server issues a challenge; the
// client solves it and submits the proof with register.
export interface PowChallenge {
    nonce: string; // single-use, base64url; also the Argon2 salt
    m: number; // Argon2id memory cost, KiB
    t: number; // iterations
    p: number; // parallelism
    bits: number; // required leading zero bits; 0 ⇒ disabled (test/e2e)
}

export interface PowProof {
    nonce: string;
    counter: number;
}

export interface RegisterRequest {
    handle: string;
    device_label: string;
    auth_public_key: string;
    sharing_public_key: string;
    // v2 accounts send both; v1 (legacy mnemonic) omits both.
    salt?: string;
    kdf?: KdfParams;
    // Proof-of-work over a server-issued challenge (ADR-0020).
    pow: PowProof;
}

export interface RegisterResponse {
    user_id: string;
    device_id: string;
    token: string;
    handle: string;
}

// Shape of the handle projection at handles/{handle}.json when it's a
// live (registered) account. Returned as the body of `resolve()` when
// status === 'live'.
export interface ResolveLiveData {
    user_id: string;
    sharing_public_key: string;
    display_name?: string;
    avatar_url?: string;
    // v2 accounts only — consumed by the login fork to re-derive keys.
    salt?: string;
    kdf?: KdfParams;
    key_version?: number;
}

/**
 * `resolve()` returns a discriminated union over the three handle states
 * (ADR-0013):
 *  - `live` — the handle is registered; live projection is in `data`.
 *  - `not_found` — the handle has never been registered (or its cooldown
 *    tombstone has elapsed and been swept).
 *  - `released` — the handle was deleted; in cooldown until `available_at`.
 */
export type ResolveResult =
    | ({ status: 'live' } & ResolveLiveData)
    | { status: 'not_found' }
    | { status: 'released'; released_at: string; available_at: string };

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

export interface RotateKeysRequest {
    request_id: string; // UUID v4 — idempotency key; reuse for retries.
    key_version: number;
    auth_public_key: string;
    sharing_public_key: string;
    salt: string;
    kdf: KdfParams;
    continuity_signature: string;
}

export interface RotateKeysResponse {
    token: string;
    key_version: number;
}

export interface AddDeviceRequest {
    user_id: string;
    device_label: string;
    auth_proof: {
        payload: {
            user_id: string;
            device_id: string;
            timestamp: string;
            key_version: number;
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
            key_version: number;
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

export function getRegisterChallenge(): Promise<PowChallenge> {
    return request('GET', '/v1/register/challenge');
}

export function register(req: RegisterRequest): Promise<RegisterResponse> {
    return request('POST', '/v1/register', { body: req });
}

export function addDevice(req: AddDeviceRequest): Promise<AddDeviceResponse> {
    return request('POST', '/v1/devices', { body: req });
}

/**
 * Rotate the account's credential-derived keys. Throws
 * `KeyVersionStaleError` on a 401 (token bound to old kv) or 409
 * (race-lost: another rotation already happened); a fresh derivation at
 * `error.current + 1` is required before the next attempt. Other errors
 * surface as `APIError`. Caller is responsible for keeping `request_id`
 * stable across retries so the server can deduplicate.
 */
export function rotateKeys(
    token: string,
    req: RotateKeysRequest,
): Promise<RotateKeysResponse> {
    return request('POST', '/v1/rotate-keys', { token, body: req });
}

export async function listDevices(
    token: string,
    userId: string,
): Promise<DeviceInfo[]> {
    const prefix = path.devices(userId);
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

// Permanently delete the caller's account: server wipes all per-user data and
// writes a 30-day handle tombstone (ADR-0013). The token authenticates the
// in-flight request; subsequent requests 401 once the device file is gone.
export function deleteProfile(token: string): Promise<void> {
    return request('DELETE', '/v1/profile', { token });
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

/**
 * Resolve a handle to its current state (live / not_found / released).
 * Dispatches on HTTP status:
 *   200 → live projection
 *   404 → never-registered or post-cooldown
 *   410 → in 30-day cooldown after deletion ({released_at, available_at})
 * Other 4xx/5xx surface as APIError, same as elsewhere.
 */
export async function resolve(handle: string): Promise<ResolveResult> {
    const res = await fetch(`/v1/resolve/${encodeURIComponent(handle)}`);
    if (res.status === 404) return { status: 'not_found' };
    if (res.status === 410) {
        const body = (await res.json().catch(() => ({}))) as {
            released_at?: string;
            available_at?: string;
        };
        return {
            status: 'released',
            released_at: body.released_at ?? '',
            available_at: body.available_at ?? '',
        };
    }
    if (!res.ok) await throwForErrorResponse(res);
    const data = (await res.json()) as ResolveLiveData;
    return { status: 'live', ...data };
}

// POST /v1/send is idempotent by `msg_id` (the server keys each envelope on
// `inbox/{to}/live/{msg_id}` and overwrites on a repeat), so retrying the
// *same* envelopes after a transient failure cannot duplicate. This is what
// makes the ambiguous-success case — server committed the write but the
// client saw a 5xx or a dropped connection — converge to exactly once
// (invariant I2): the retry reuses the already-minted `msg_id`s rather than
// surfacing an error that prompts a fresh-id resend. A 4xx (e.g. forbidden,
// bad_request) is terminal and fails fast.
const SEND_ATTEMPTS = 3;

export async function send(
    token: string,
    envelopes: Envelope[],
): Promise<void> {
    let lastErr: unknown;
    for (let attempt = 0; attempt < SEND_ATTEMPTS; attempt++) {
        try {
            await request<void>('POST', '/v1/send', {
                token,
                body: { envelopes },
            });
            return;
        } catch (e) {
            // 4xx is the caller's fault (auth, malformed) — don't retry.
            if (e instanceof APIError && e.status < 500) throw e;
            // 5xx or a network/connection error: the write may or may not
            // have committed; retrying the same msg_ids is safe either way.
            lastErr = e;
        }
    }
    throw lastErr;
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

/**
 * List **every** key under a prefix, paging through all result pages.
 * `storeList` returns at most one server page (`STORE_LIST_LIMIT` keys) plus a
 * `next_cursor`; loop, passing the cursor back as S3 `start-after`, until the
 * server reports no more pages (empty `next_cursor`). The cursor is the last
 * key of each page, so it strictly advances — the loop always terminates.
 */
export async function storeListAll(
    token: string,
    prefix: string,
): Promise<string[]> {
    const keys: string[] = [];
    let cursor: string | undefined;
    do {
        const page = await storeList(token, prefix, cursor);
        keys.push(...page.keys);
        cursor = page.next_cursor || undefined;
    } while (cursor);
    return keys;
}

export async function storeGet(
    token: string,
    key: string,
): Promise<ArrayBuffer> {
    const res = await fetch(
        `/v1/store/object?${new URLSearchParams({ key })}`,
        { headers: { Authorization: `Bearer ${token}` } },
    );
    if (!res.ok) await throwForErrorResponse(res);
    return res.arrayBuffer();
}

export interface StorageUsage {
    used_bytes: number;
    quota_bytes: number;
    blob_count: number;
    quota_blob_cap: number;
}

// The caller's media usage, for the settings storage indicator. Server-cached
// (TTL 10 min), so the figure can lag a recent upload.
export function getStorageUsage(token: string): Promise<StorageUsage> {
    return request('GET', '/v1/store/usage', { token });
}

// Owner-only delete of an S3 object. Used by the message-delete amendment
// path to drop the underlying media blob (ADR-0014). Idempotent server-side:
// deleting an absent key returns 200.
export function storeDelete(token: string, key: string): Promise<void> {
    return request(
        'DELETE',
        `/v1/store/object?${new URLSearchParams({ key })}`,
        {
            token,
        },
    );
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

export async function putWithRetry(
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
    const key = path.media(userId, mediaUlid);

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
