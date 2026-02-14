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
    timestamp?: number; // Unix timestamp in milliseconds
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

// --- API functions ---

export function register(req: RegisterRequest): Promise<RegisterResponse> {
    return request('POST', '/v1/register', { body: req });
}

export function addDevice(req: AddDeviceRequest): Promise<AddDeviceResponse> {
    return request('POST', '/v1/devices', { body: req });
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

// Helper to send an encrypted text message
export async function sendTextMessage(
    token: string,
    fromUserId: string,
    fromDeviceId: string,
    toUserId: string,
    toPublicKeyBytes: Uint8Array,
    messageText: string,
): Promise<void> {
    // Import crypto functions
    const { eciesEncrypt, importX25519PublicKey, base64UrlEncode } =
        await import('./crypto');

    // Import recipient's public key
    const recipientPubKey = await importX25519PublicKey(toPublicKeyBytes);

    // Encrypt the message
    const encrypted = await eciesEncrypt(
        recipientPubKey,
        new TextEncoder().encode(messageText),
    );

    // Create envelope
    const envelope: Envelope = {
        v: 1,
        to_user: toUserId,
        from_user: fromUserId,
        from_device: fromDeviceId,
        msg_id: crypto.randomUUID(),
        content_type: 'text/plain',
        timestamp: Date.now(),
        payload: {
            ephemeral_key: base64UrlEncode(encrypted.ephemeralKey),
            iv: base64UrlEncode(encrypted.iv),
            ciphertext: base64UrlEncode(encrypted.ciphertext),
        },
    };

    return send(token, [envelope]);
}

// Helper to fetch and decrypt messages from inbox
export interface DecryptedMessage {
    id: string;
    fromUser: string;
    fromDevice: string;
    text: string;
    timestamp: Date;
}

export async function fetchMessages(
    token: string,
    userId: string,
    sharingPrivateKey: CryptoKey,
): Promise<DecryptedMessage[]> {
    const { eciesDecrypt, base64UrlDecode } = await import('./crypto');

    // List all messages in inbox
    const prefix = `inbox/${userId}/live/`;
    const listRes = await storeList(token, prefix);

    const messages: DecryptedMessage[] = [];

    // Fetch and decrypt each message
    for (const key of listRes.keys) {
        try {
            // Fetch envelope
            const blob = await storeGet(token, key);
            const envelope = JSON.parse(
                new TextDecoder().decode(blob),
            ) as Envelope;

            // Only handle text/plain messages for now
            if (envelope.content_type !== 'text/plain') continue;

            // Decrypt payload
            const encryptedPayload = {
                ephemeralKey: base64UrlDecode(envelope.payload.ephemeral_key),
                iv: base64UrlDecode(envelope.payload.iv),
                ciphertext: base64UrlDecode(envelope.payload.ciphertext),
            };

            const plaintext = await eciesDecrypt(
                sharingPrivateKey,
                encryptedPayload,
            );
            const text = new TextDecoder().decode(plaintext);

            messages.push({
                id: envelope.msg_id,
                fromUser: envelope.from_user,
                fromDevice: envelope.from_device,
                text,
                timestamp: new Date(envelope.timestamp ?? 0),
            });
        } catch (error) {
            console.error(`Failed to decrypt message ${key}:`, error);
            // Skip messages we can't decrypt
        }
    }

    // Sort by timestamp
    return messages.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
}
