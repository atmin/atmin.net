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
    display_name?: string;
    avatar_url?: string;
}

export interface ProfileUpdateRequest {
    display_name?: string;
    avatar_url?: string;
}

export interface Envelope {
    v: number;
    to_user: string;
    from_user: string;
    from_device: string;
    msg_id: string;
    content_type: string;
    sent_at?: string; // ISO 8601 timestamp
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

import { decode as cborDecode } from 'cbor-x';
import type { SessionManager } from './megolm-session';

// Deterministic conversation ID
export function conversationId(userA: string, userB: string): string {
    if (userA === userB) return `self:${userA}`;
    const [a, b] = [userA, userB].sort();
    return `dm:${a}:${b}`;
}

// Helper to send an encrypted text message
export async function sendTextMessage(
    token: string,
    fromUserId: string,
    fromDeviceId: string,
    toUserId: string,
    toPublicKeyBytes: Uint8Array,
    selfPublicKeyBytes: Uint8Array,
    messageText: string,
    sessionManager: SessionManager,
): Promise<void> {
    const { eciesEncrypt, importX25519PublicKey, base64UrlEncode } =
        await import('./crypto');
    const { ulid } = await import('ulid');

    // Get or create outbound session
    let [session, isNew] = await sessionManager.getOutbound();

    // Rotate if threshold reached
    if (sessionManager.needsRotation(session)) {
        session = await sessionManager.rotate();
        isNew = true;
    }

    const envelopes: Envelope[] = [];
    const convId = conversationId(fromUserId, toUserId);

    // Send key share if needed for this recipient
    const needsShare =
        isNew ||
        !(await sessionManager.hasSharedWith(session.session_id, toUserId));

    if (needsShare) {
        const sessionKeyBytes = new TextEncoder().encode(session.session_key());
        const keyShareMsgId = ulid();

        // Key share to recipient
        const recipientPubKey = await importX25519PublicKey(toPublicKeyBytes);
        const encrypted = await eciesEncrypt(recipientPubKey, sessionKeyBytes);
        envelopes.push({
            v: 1,
            to_user: toUserId,
            from_user: fromUserId,
            from_device: fromDeviceId,
            msg_id: keyShareMsgId,
            content_type: 'megolm.key_share',
            sent_at: new Date().toISOString(),
            payload: {
                conversation_id: convId,
                ephemeral_key: base64UrlEncode(encrypted.ephemeralKey),
                iv: base64UrlEncode(encrypted.iv),
                ciphertext: base64UrlEncode(encrypted.ciphertext),
            },
        });

        // Key share to self (so other devices can decrypt self-copies)
        if (toUserId !== fromUserId) {
            const selfPubKey = await importX25519PublicKey(selfPublicKeyBytes);
            const selfEncrypted = await eciesEncrypt(
                selfPubKey,
                sessionKeyBytes,
            );
            envelopes.push({
                v: 1,
                to_user: fromUserId,
                from_user: fromUserId,
                from_device: fromDeviceId,
                msg_id: ulid(),
                content_type: 'megolm.key_share',
                sent_at: new Date().toISOString(),
                payload: {
                    conversation_id: convId,
                    ephemeral_key: base64UrlEncode(selfEncrypted.ephemeralKey),
                    iv: base64UrlEncode(selfEncrypted.iv),
                    ciphertext: base64UrlEncode(selfEncrypted.ciphertext),
                },
            });
        }
    }

    // Encrypt message with Megolm
    const ciphertext = session.encrypt(messageText);
    const msgId = ulid();

    // Message to recipient
    envelopes.push({
        v: 1,
        to_user: toUserId,
        from_user: fromUserId,
        from_device: fromDeviceId,
        msg_id: msgId,
        content_type: 'megolm.message',
        sent_at: new Date().toISOString(),
        payload: {
            conversation_id: convId,
            session_id: session.session_id,
            ciphertext,
        },
    });

    // Self-copy
    if (toUserId !== fromUserId) {
        envelopes.push({
            v: 1,
            to_user: fromUserId,
            from_user: fromUserId,
            from_device: fromDeviceId,
            msg_id: msgId,
            content_type: 'megolm.message',
            sent_at: new Date().toISOString(),
            payload: {
                conversation_id: convId,
                session_id: session.session_id,
                ciphertext,
            },
        });
    }

    // Persist outbound state (ratchet advanced)
    await sessionManager.persistOutbound(session);

    if (needsShare) {
        await sessionManager.recordShare(session.session_id, toUserId);
    }

    await send(token, envelopes);
}

// Helper to fetch and decrypt messages from inbox
export interface DecryptedMessage {
    id: string;
    conversationId: string;
    fromUser: string;
    fromDevice: string;
    text: string;
    timestamp: Date;
}

// Process envelopes through two-pass decryption (key shares first, then messages).
// Returns decrypted messages and the set of inbound session IDs whose ratchets advanced.
async function processEnvelopes(
    envelopes: Array<{ key: string; envelope: Envelope }>,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager: SessionManager | undefined,
    seenMsgIds: Set<string>,
): Promise<{ messages: DecryptedMessage[]; advancedInbounds: Set<string> }> {
    const { eciesDecrypt, base64UrlDecode } = await import('./crypto');

    // Pass 1: process key shares first (so session keys are available for messages)
    if (sessionManager) {
        for (const { key, envelope } of envelopes) {
            if (envelope.content_type !== 'megolm.key_share') continue;
            if (seenMsgIds.has(envelope.msg_id)) continue;
            try {
                const encryptedPayload = {
                    ephemeralKey: base64UrlDecode(
                        envelope.payload.ephemeral_key,
                    ),
                    iv: base64UrlDecode(envelope.payload.iv),
                    ciphertext: base64UrlDecode(envelope.payload.ciphertext),
                };
                const sessionKeyBytes = await eciesDecrypt(
                    sharingPrivateKey,
                    encryptedPayload,
                );
                const sessionKeyB64 = new TextDecoder().decode(sessionKeyBytes);
                await sessionManager.addInbound(
                    envelope.from_user,
                    envelope.from_device,
                    sessionKeyB64,
                );
            } catch (error) {
                console.error(`Failed to process key share ${key}:`, error);
            }
        }
    }

    // Pass 2: process messages
    const messages: DecryptedMessage[] = [];
    const advancedInbounds = new Set<string>();
    for (const { key, envelope } of envelopes) {
        try {
            if (envelope.content_type === 'megolm.key_share') continue;
            if (seenMsgIds.has(envelope.msg_id)) continue;

            if (envelope.content_type === 'megolm.message' && sessionManager) {
                const sessionId = envelope.payload.session_id;
                const inbound = await sessionManager.getInbound(sessionId);
                if (!inbound) {
                    console.warn(
                        `Unknown Megolm session ${sessionId} for ${key}`,
                    );
                    continue;
                }
                const text = inbound.decrypt(envelope.payload.ciphertext);
                advancedInbounds.add(sessionId);
                messages.push({
                    id: envelope.msg_id,
                    conversationId:
                        envelope.payload.conversation_id ??
                        conversationId(envelope.from_user, userId),
                    fromUser: envelope.from_user,
                    fromDevice: envelope.from_device,
                    text,
                    timestamp: new Date(envelope.sent_at ?? 0),
                });
                seenMsgIds.add(envelope.msg_id);
            }
        } catch (error) {
            console.error(`Failed to decrypt message ${key}:`, error);
        }
    }

    return { messages, advancedInbounds };
}

// Fetch and decrypt messages from CBOR archive blobs
export async function fetchArchiveMessages(
    token: string,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager: SessionManager | undefined,
    seenMsgIds: Set<string>,
): Promise<{ messages: DecryptedMessage[]; advancedInbounds: Set<string> }> {
    const archivePrefix = `inbox/${userId}/archive/`;
    let listRes: StoreListResponse;
    try {
        listRes = await storeList(token, archivePrefix);
    } catch {
        return { messages: [], advancedInbounds: new Set() };
    }

    if (listRes.keys.length === 0) {
        return { messages: [], advancedInbounds: new Set() };
    }

    // Fetch and decode all CBOR archive blobs
    const allEnvelopes: Array<{ key: string; envelope: Envelope }> = [];
    for (const key of listRes.keys) {
        try {
            const blob = await storeGet(token, key);
            const decoded = cborDecode(new Uint8Array(blob)) as Envelope[];
            for (const envelope of decoded) {
                allEnvelopes.push({ key, envelope });
            }
        } catch (error) {
            console.error(`Failed to fetch/decode archive ${key}:`, error);
        }
    }

    return processEnvelopes(
        allEnvelopes,
        userId,
        sharingPrivateKey,
        sessionManager,
        seenMsgIds,
    );
}

export async function fetchMessages(
    token: string,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager?: SessionManager,
): Promise<DecryptedMessage[]> {
    const { loadSyncCursor, saveSyncCursor } = await import('./db');

    // List messages in inbox, resuming from stored cursor if available
    const prefix = `inbox/${userId}/live/`;
    const storedCursor = await loadSyncCursor(prefix);

    let listRes: StoreListResponse;
    try {
        listRes = await storeList(token, prefix, storedCursor);
    } catch {
        // Cursor may be stale (e.g. after compaction); fall back to full fetch
        listRes = await storeList(token, prefix);
    }

    // Fetch all live envelopes
    const envelopes: Array<{ key: string; envelope: Envelope }> = [];
    for (const key of listRes.keys) {
        try {
            const blob = await storeGet(token, key);
            const envelope = JSON.parse(
                new TextDecoder().decode(blob),
            ) as Envelope;
            envelopes.push({ key, envelope });
        } catch (error) {
            console.error(`Failed to fetch envelope ${key}:`, error);
        }
    }

    // Process live envelopes
    const seenMsgIds = new Set<string>();
    for (const { envelope } of envelopes) {
        seenMsgIds.add(envelope.msg_id);
    }

    const live = await processEnvelopes(
        envelopes,
        userId,
        sharingPrivateKey,
        sessionManager,
        new Set(), // no dedup needed for live pass
    );

    // Process archive envelopes (dedup against live msg_ids)
    const archive = await fetchArchiveMessages(
        token,
        userId,
        sharingPrivateKey,
        sessionManager,
        seenMsgIds,
    );

    // Persist inbound sessions whose ratchets advanced during decryption
    const allAdvanced = new Set([
        ...live.advancedInbounds,
        ...archive.advancedInbounds,
    ]);
    if (sessionManager) {
        for (const sessionId of allAdvanced) {
            await sessionManager.persistInbound(sessionId);
        }
    }

    // Persist cursor so next sync only fetches new objects
    if (listRes.keys.length > 0) {
        const lastKey = listRes.keys[listRes.keys.length - 1];
        await saveSyncCursor(prefix, lastKey);
        // Compact processed live objects into daily archive (fire-and-forget)
        const upTo = lastKey.slice(prefix.length);
        storeCompact(token, prefix, upTo).catch(console.error);
    }

    const messages = [...live.messages, ...archive.messages];
    return messages.sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
}
