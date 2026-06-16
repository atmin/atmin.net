import { decode as cborDecode } from 'cbor-x';
import { ulid } from 'ulid';
import {
    type StoreListResponse,
    send,
    storeCompact,
    storeGet,
    storeList,
    storeListAll,
} from './api';
import {
    base64UrlDecode,
    base64UrlEncode,
    eciesDecrypt,
    eciesEncrypt,
    importSharingPublicKey,
} from './crypto';
import {
    deletePendingKeyBackup,
    enqueuePendingKeyBackup,
    listPendingKeyBackups,
    loadIngestedArchiveKeys,
    loadMessageIds,
    loadSyncCursor,
    saveSyncCursor,
} from './db';
import type { Envelope } from './envelope';
import { backupSessionKey } from './key-backup';
import type { SessionManager } from './megolm-session';
import { path } from './paths';

export function conversationId(userA: string, userB: string): string {
    if (userA === userB) return `self:${userA}`;
    const [a, b] = [userA, userB].sort();
    return `dm:${a}:${b}`;
}

// Inner plaintext shapes (what gets Megolm-encrypted). Every message is a
// self-describing JSON object discriminated by `type`; see
// docs/specs/mvp-v0.1.md "Payload by content type" and ADR-0014. The
// materializer (useChat) also accepts legacy bare-string plaintext from
// pre-typed-envelope clients and treats it as text.
export interface TextPayload {
    type: 'text';
    body: string;
}

export interface MediaPayload {
    type: 'media';
    body: string; // caption (defaults to the file name)
    file: {
        url: string;
        key: string;
        iv: string;
        name: string;
        size: number;
    };
}

export type AmendmentAction = 'edit' | 'delete';

export interface AmendmentPayload {
    type: 'amendment';
    target_msg_id: string;
    action: AmendmentAction;
    body?: string; // present iff action === 'edit'
}

export type InnerPayload = TextPayload | MediaPayload | AmendmentPayload;

// Thin wrapper preserving the historical string API: text is the common
// case and most callers (and tests) pass a bare string.
export function sendTextMessage(
    token: string,
    fromUserId: string,
    fromDeviceId: string,
    toUserId: string,
    toPublicKeyBytes: Uint8Array,
    selfPublicKeyBytes: Uint8Array,
    messageText: string,
    sessionManager: SessionManager,
): Promise<void> {
    return sendInnerPayload(
        token,
        fromUserId,
        fromDeviceId,
        toUserId,
        toPublicKeyBytes,
        selfPublicKeyBytes,
        { type: 'text', body: messageText },
        sessionManager,
    );
}

// Encrypt and send an inner payload. Text, media, and amendments all flow
// through here so the session-rotation, key-share, and self-copy logic lives
// in exactly one place. The payload is JSON-serialized before encryption.
export async function sendInnerPayload(
    token: string,
    fromUserId: string,
    fromDeviceId: string,
    toUserId: string,
    toPublicKeyBytes: Uint8Array,
    selfPublicKeyBytes: Uint8Array,
    payload: InnerPayload,
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

    const ciphertext = session.encrypt(JSON.stringify(payload));
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

export interface SyncResult {
    messages: DecryptedMessage[];
    // Archive S3 keys whose every message is now materialized. The caller must
    // mark these ingested ONLY after `messages` are durably persisted — see
    // syncAndPublish in inbox-sync.ts.
    ingestedCandidates: string[];
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
): Promise<{
    messages: DecryptedMessage[];
    advancedInbounds: Set<string>;
    // Count of envelopes skipped because their Megolm session is not yet known
    // (the key may arrive later via the backup chain — ADR-0012 / I6 / I9).
    // A caller deciding whether an archive is fully materialized must treat a
    // non-zero count as "not yet" — re-fetch next sync. A *decrypt failure* on
    // a known session does NOT count here: it is recovered via the key-backup
    // chain, not via a re-download, so it must not block ingestion.
    recoverableSkips: number;
}> {
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
                    const sid = inbound.session_id;
                    backupSessionKey(
                        token,
                        userId,
                        sid,
                        sessionKeyB64,
                        backupKey,
                        keyVersion ?? 1,
                    ).catch(async (err) => {
                        // A failed key backup is future history loss — never
                        // swallow it (I10). Queue the key for retry on the next
                        // sync instead of dropping it at console.error.
                        console.error(
                            `key backup upload failed for session ${sid}; queued for retry:`,
                            err,
                        );
                        await enqueuePendingKeyBackup({
                            sessionId: sid,
                            sessionKeyB64,
                        }).catch((e) =>
                            console.error(
                                'failed to queue key backup for retry:',
                                e,
                            ),
                        );
                    });
                }
            } catch (error) {
                // Non-fatal and usually expected: a key share encrypted to a
                // superseded sharing key (pre-rotation) won't ECIES-decrypt
                // with the current one (OperationError). The session it
                // carried is recovered from the key-backup chain instead
                // (ADR-0012 / invariant I9), so this is belt-and-suspenders
                // failing, not lost history — that surfaces separately as a
                // restore warning (I6). Logged at debug to avoid alarming
                // console.error noise on accounts that have rotated.
                console.debug(`Skipped key share ${key}:`, error);
            }
        }
    }

    const messages: DecryptedMessage[] = [];
    const advancedInbounds = new Set<string>();
    let recoverableSkips = 0;
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
                    // Recoverable: the session key may arrive later via the
                    // backup chain. Flag it so the archive is not yet treated
                    // as ingested and gets re-fetched once the key is restored.
                    recoverableSkips++;
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
            // Decrypt failure on a *known* session — the I6/I9 belt-and-
            // suspenders path. Recovered via the key-backup chain, not a
            // re-download, so it must NOT count as a recoverable skip and must
            // NOT block the archive from being marked ingested.
            console.error(`Failed to decrypt message ${key}:`, error);
        }
    }

    return { messages, advancedInbounds, recoverableSkips };
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

// Fetch and decrypt messages from CBOR archive blobs, per-archive, skipping
// any archive already recorded as fully ingested (no GET at all). For each
// archive that is downloaded, decides whether it is now fully materialized and
// returns it as an *ingested candidate* — the caller marks it ingested only
// after the messages are durably persisted (see inbox-sync.ts). Lists the full
// prefix rather than trusting the (compaction-fragile) high-water cursor.
export async function syncArchive(
    token: string,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager: SessionManager | undefined,
    seenMsgIds: Set<string>,
    backupKey?: CryptoKey,
    keyVersion?: number,
): Promise<{
    messages: DecryptedMessage[];
    advancedInbounds: Set<string>;
    ingestedCandidates: string[];
}> {
    const archivePrefix = path.inboxArchive(userId);
    const ingested = await loadIngestedArchiveKeys();

    let keys: string[];
    try {
        keys = await storeListAll(token, archivePrefix);
    } catch (error) {
        console.error('Failed to list archive prefix:', error);
        return {
            messages: [],
            advancedInbounds: new Set(),
            ingestedCandidates: [],
        };
    }

    const messages: DecryptedMessage[] = [];
    const advancedInbounds = new Set<string>();
    const ingestedCandidates: string[] = [];

    // Process in listing (chronological) order so a key_share archived before
    // the message it unlocks is applied first — processEnvelopes also does a
    // key-shares-first pass within each archive.
    for (const key of keys) {
        if (ingested.has(key)) continue; // already materialized — skip the GET

        let decoded: Envelope[];
        try {
            const blob = await storeGet(token, key);
            decoded = cborDecode(new Uint8Array(blob)) as Envelope[];
        } catch (error) {
            // Download/decode failed → not a candidate; re-fetched next sync.
            console.error(`Failed to fetch/decode archive ${key}:`, error);
            continue;
        }

        const result = await processEnvelopes(
            decoded.map((envelope) => ({ key, envelope })),
            userId,
            sharingPrivateKey,
            sessionManager,
            seenMsgIds,
            token,
            backupKey,
            keyVersion,
        );
        messages.push(...result.messages);
        for (const sid of result.advancedInbounds) advancedInbounds.add(sid);

        // Candidate only if every envelope is materialized or a non-message
        // (corollary 1 + 2). A recoverable skip (unknown session) means a key
        // may still arrive — leave it un-ingested so it is re-fetched.
        if (result.recoverableSkips === 0) ingestedCandidates.push(key);
    }

    return { messages, advancedInbounds, ingestedCandidates };
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

let syncInFlight: Promise<SyncResult> | null = null;

export function syncMessages(
    token: string,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager?: SessionManager,
    backupKey?: CryptoKey,
    keyVersion?: number,
): Promise<SyncResult> {
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

/**
 * Retry key backups that previously failed to upload (I10). Drains the
 * pending-backup queue, re-encrypting each under the *current* backup key, and
 * drops an entry only once its upload succeeds. Best-effort: entries that still
 * fail stay queued for the next sync.
 */
export async function flushPendingKeyBackups(
    token: string,
    userId: string,
    backupKey: CryptoKey,
    keyVersion: number,
): Promise<void> {
    const pending = await listPendingKeyBackups();
    for (const { sessionId, sessionKeyB64 } of pending) {
        try {
            await backupSessionKey(
                token,
                userId,
                sessionId,
                sessionKeyB64,
                backupKey,
                keyVersion,
            );
            await deletePendingKeyBackup(sessionId);
        } catch (err) {
            console.error(
                `key backup retry failed for session ${sessionId}; still queued:`,
                err,
            );
        }
    }
}

export async function fetchMessages(
    token: string,
    userId: string,
    sharingPrivateKey: CryptoKey,
    sessionManager?: SessionManager,
    backupKey?: CryptoKey,
    keyVersion?: number,
): Promise<SyncResult> {
    const live = await syncLive(
        token,
        userId,
        sharingPrivateKey,
        sessionManager,
        backupKey,
        keyVersion,
    );

    // Seed dedup from messages already in IDB (keys-only read), then add this
    // sync's live IDs. This skips re-decrypting any already-stored message
    // inside a re-downloaded (compacted/merged) archive, and makes the
    // per-archive "fully materialized" check meaningful — an envelope whose
    // msg_id is already stored counts as materialized, not as a skip.
    const seenMsgIds = await loadMessageIds(userId);
    for (const m of live.messages) seenMsgIds.add(m.id);
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

    // Retry any key backups that failed on a previous sync (I10). Fire-and-
    // forget; an empty queue (the common case) is a single cheap IDB read.
    if (token && backupKey) {
        flushPendingKeyBackups(token, userId, backupKey, keyVersion ?? 1).catch(
            (err) => console.error('pending key-backup flush failed:', err),
        );
    }

    return {
        messages: [...live.messages, ...archive.messages].sort(
            (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
        ),
        ingestedCandidates: archive.ingestedCandidates,
    };
}
