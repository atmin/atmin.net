import { decode as cborDecode } from 'cbor-x';
import { ulid } from 'ulid';
import {
    type StoreListResponse,
    send,
    storeCompact,
    storeGet,
    storeList,
} from './api';
import {
    base64UrlDecode,
    base64UrlEncode,
    eciesDecrypt,
    eciesEncrypt,
    importSharingPublicKey,
} from './crypto';
import { loadSyncCursor, saveSyncCursor } from './db';
import type { Envelope } from './envelope';
import { backupSessionKey } from './key-backup';
import type { SessionManager } from './megolm-session';
import { path } from './paths';

export function conversationId(userA: string, userB: string): string {
    if (userA === userB) return `self:${userA}`;
    const [a, b] = [userA, userB].sort();
    return `dm:${a}:${b}`;
}

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
    let [session, isNew] = await sessionManager.getOutbound();

    if (sessionManager.needsRotation(session)) {
        session = await sessionManager.rotate();
        isNew = true;
    }

    const envelopes: Envelope[] = [];
    const convId = conversationId(fromUserId, toUserId);

    const needsShare =
        isNew ||
        !(await sessionManager.hasSharedWith(session.session_id, toUserId));

    if (needsShare) {
        const sessionKeyBytes = new TextEncoder().encode(session.session_key());
        const keyShareMsgId = ulid();

        const recipientPubKey = await importSharingPublicKey(toPublicKeyBytes);
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

        if (toUserId !== fromUserId) {
            const selfPubKey = await importSharingPublicKey(selfPublicKeyBytes);
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

    const ciphertext = session.encrypt(messageText);
    const msgId = ulid();

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

    await sessionManager.persistOutbound(session);

    await send(token, envelopes);
    if (needsShare) {
        await sessionManager.recordShare(session.session_id, toUserId);
    }
}

export interface DecryptedMessage {
    id: string;
    conversationId: string;
    fromUser: string;
    fromDevice: string;
    text: string;
    timestamp: Date;
}

async function processEnvelopes(
    envelopes: Array<{ key: string; envelope: Envelope }>,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager: SessionManager | undefined,
    seenMsgIds: Set<string>,
    token?: string,
    backupKey?: CryptoKey,
    keyVersion?: number,
): Promise<{ messages: DecryptedMessage[]; advancedInbounds: Set<string> }> {
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
                const [inbound, isNew] = await sessionManager.addInbound(
                    envelope.from_user,
                    envelope.from_device,
                    sessionKeyB64,
                );
                if (isNew && token && backupKey) {
                    backupSessionKey(
                        token,
                        userId,
                        inbound.session_id,
                        sessionKeyB64,
                        backupKey,
                        keyVersion ?? 1,
                    ).catch((err) => console.error('Key backup failed:', err));
                }
            } catch (error) {
                console.error(`Failed to process key share ${key}:`, error);
            }
        }
    }

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

// Fetch and decrypt new live inbox messages. Returns decrypted messages,
// advanced inbound session IDs, the last live key (for cursor + compaction),
// and the live prefix. Does not persist the cursor — fetchMessages does that.
export async function syncLive(
    token: string,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager: SessionManager | undefined,
    backupKey?: CryptoKey,
    keyVersion?: number,
): Promise<{
    messages: DecryptedMessage[];
    advancedInbounds: Set<string>;
    lastKey: string | undefined;
    prefix: string;
}> {
    const prefix = path.inboxLive(userId);
    const storedCursor = await loadSyncCursor(prefix);

    let listRes: StoreListResponse;
    try {
        listRes = await storeList(token, prefix, storedCursor);
    } catch {
        listRes = await storeList(token, prefix);
    }

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

    const result = await processEnvelopes(
        envelopes,
        userId,
        sharingPrivateKey,
        sessionManager,
        new Set(),
        token,
        backupKey,
        keyVersion,
    );

    const lastKey =
        listRes.keys.length > 0
            ? listRes.keys[listRes.keys.length - 1]
            : undefined;
    return { ...result, lastKey, prefix };
}

// Fetch and decrypt messages from CBOR archive blobs, deduplicating against
// already-seen live message IDs. Manages its own archive cursor.
export async function syncArchive(
    token: string,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager: SessionManager | undefined,
    seenMsgIds: Set<string>,
    backupKey?: CryptoKey,
    keyVersion?: number,
): Promise<{ messages: DecryptedMessage[]; advancedInbounds: Set<string> }> {
    const archivePrefix = path.inboxArchive(userId);
    const storedCursor = await loadSyncCursor(archivePrefix);

    let listRes: StoreListResponse;
    try {
        listRes = await storeList(token, archivePrefix, storedCursor);
    } catch {
        try {
            listRes = await storeList(token, archivePrefix);
        } catch {
            return { messages: [], advancedInbounds: new Set() };
        }
    }

    if (!listRes?.keys?.length) {
        return { messages: [], advancedInbounds: new Set() };
    }

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

    const lastKey = listRes.keys[listRes.keys.length - 1];
    await saveSyncCursor(archivePrefix, lastKey);

    return processEnvelopes(
        allEnvelopes,
        userId,
        sharingPrivateKey,
        sessionManager,
        seenMsgIds,
        token,
        backupKey,
        keyVersion,
    );
}

export async function persistInbounds(
    sessionManager: SessionManager,
    sessionIds: Set<string>,
): Promise<void> {
    for (const sessionId of sessionIds) {
        await sessionManager.persistInbound(sessionId);
    }
}

function triggerCompaction(
    token: string,
    userId: string,
    prefix: string,
    lastKey: string,
): void {
    const upTo = lastKey.slice(prefix.length);
    storeCompact(token, prefix, upTo).catch(console.error);
    storeCompact(token, path.keysLive(userId), '~').catch(console.error);
}

let syncInFlight: Promise<DecryptedMessage[]> | null = null;

export function syncMessages(
    token: string,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager?: SessionManager,
    backupKey?: CryptoKey,
    keyVersion?: number,
): Promise<DecryptedMessage[]> {
    if (syncInFlight) return syncInFlight;
    syncInFlight = fetchMessages(
        token,
        userId,
        sharingPrivateKey,
        sessionManager,
        backupKey,
        keyVersion,
    ).finally(() => {
        syncInFlight = null;
    });
    return syncInFlight;
}

export async function fetchMessages(
    token: string,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager?: SessionManager,
    backupKey?: CryptoKey,
    keyVersion?: number,
): Promise<DecryptedMessage[]> {
    const live = await syncLive(
        token,
        userId,
        sharingPrivateKey,
        sessionManager,
        backupKey,
        keyVersion,
    );

    const seenMsgIds = new Set(live.messages.map((m) => m.id));
    const archive = await syncArchive(
        token,
        userId,
        sharingPrivateKey,
        sessionManager,
        seenMsgIds,
        backupKey,
        keyVersion,
    );

    const allAdvanced = new Set([
        ...live.advancedInbounds,
        ...archive.advancedInbounds,
    ]);
    if (sessionManager) {
        await persistInbounds(sessionManager, allAdvanced);
    }

    if (live.lastKey !== undefined) {
        await saveSyncCursor(live.prefix, live.lastKey);
        triggerCompaction(token, userId, live.prefix, live.lastKey);
    }

    return [...live.messages, ...archive.messages].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
}
