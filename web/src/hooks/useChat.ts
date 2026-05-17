import { useEffect, useState } from 'react';
import {
    conversationId,
    resolve,
    sendTextMessage,
    uploadMedia,
} from '@/lib/api';
import type { Session } from '@/lib/auth';
import { uploadContacts } from '@/lib/contact-backup';
import { base64UrlDecode, base64UrlEncode } from '@/lib/crypto';
import { loadMessages as loadFromDB, saveContact } from '@/lib/db';
import { onInboxUpdated, syncAndPublish } from '@/lib/inbox-sync';
import type { MediaFile } from '@/lib/media';
import { encryptMedia } from '@/lib/media';
import type { SessionManager } from '@/lib/megolm-session';

export interface Message {
    id: string;
    text: string;
    timestamp: Date;
    sent: boolean;
    media?: MediaFile;
}

interface MediaEnvelope {
    type: 'media';
    body: string;
    file: {
        url: string;
        key: string;
        iv: string;
        name: string;
        size: number;
    };
}

function parseMediaEnvelope(text: string): MediaEnvelope | null {
    if (!text.startsWith('{')) return null;
    try {
        const obj = JSON.parse(text);
        if (
            obj?.type === 'media' &&
            typeof obj.body === 'string' &&
            obj.file?.url &&
            obj.file?.key &&
            obj.file?.iv &&
            typeof obj.file?.name === 'string' &&
            typeof obj.file?.size === 'number'
        ) {
            return obj as MediaEnvelope;
        }
    } catch {
        // not JSON
    }
    return null;
}

function toMessages(
    msgs: { id: string; text: string; timestamp: Date; fromUser: string }[],
    userId: string,
): Message[] {
    return msgs.map((m) => {
        const env = parseMediaEnvelope(m.text);
        if (env) {
            return {
                id: m.id,
                text: env.body,
                timestamp: m.timestamp,
                sent: m.fromUser === userId,
                media: {
                    url: env.file.url,
                    key: base64UrlDecode(env.file.key),
                    iv: base64UrlDecode(env.file.iv),
                    name: env.file.name,
                    size: env.file.size,
                },
            };
        }
        return {
            id: m.id,
            text: m.text,
            timestamp: m.timestamp,
            sent: m.fromUser === userId,
        };
    });
}

export interface ChatState {
    messages: Message[];
    loading: boolean;
    sending: boolean;
    encryptionReady: boolean;
    chatTitle: string;
    sendMessage: (text: string) => Promise<void>;
    sendMedia: (file: File) => Promise<void>;
}

export function useChat(
    handle: string | undefined,
    session: Session,
    sessionManager: SessionManager | null,
): ChatState {
    const isSaved = handle === 'saved';

    const [messages, setMessages] = useState<Message[]>([]);
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(true);
    const [convId, setConvId] = useState<string | null>(null);
    const [chatTitle, setChatTitle] = useState(
        isSaved ? 'Saved Messages' : (handle ?? ''),
    );

    // Resolve conversation ID from handle
    useEffect(() => {
        if (isSaved) {
            setConvId(conversationId(session.userId, session.userId));
            return;
        }
        if (!handle) return;

        resolve(handle).then(async (res) => {
            if (res.display_name) setChatTitle(res.display_name);
            await saveContact(res.user_id, handle);
            uploadContacts(
                session.token,
                session.userId,
                session.backupKey,
            ).catch((err) => console.error('Contact backup failed:', err));
            setConvId(conversationId(session.userId, res.user_id));
        });
    }, [handle, isSaved, session]);

    // Read from IndexedDB immediately on convId change, then subscribe to
    // inbox updates. useInboxSync (in app.tsx) owns the SSE connection and
    // calls syncAndPublish; we just re-read IDB whenever it notifies us.
    useEffect(() => {
        if (!convId) return;

        const refresh = async () => {
            try {
                const all = await loadFromDB(session.userId);
                const filtered = all
                    .filter((m) => m.conversationId === convId)
                    .map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
                setMessages(toMessages(filtered, session.userId));
            } catch (err) {
                console.error('Failed to load messages from IDB:', err);
            } finally {
                setLoading(false);
            }
        };

        // Initial read — picks up cached data and any sync that already landed.
        refresh();
        return onInboxUpdated(refresh);
    }, [convId, session.userId]);

    const sendMessage = async (text: string) => {
        if (!text || sending || !sessionManager) return;

        setSending(true);
        try {
            let recipientUserId: string;
            let recipientPubKeyBytes: Uint8Array;

            if (isSaved) {
                recipientUserId = session.userId;
                recipientPubKeyBytes = session.sharingPublicKeyBytes;
            } else {
                if (!handle) throw new Error('No recipient handle');
                const resolveRes = await resolve(handle);
                recipientUserId = resolveRes.user_id;
                recipientPubKeyBytes = base64UrlDecode(
                    resolveRes.sharing_public_key,
                );
            }

            await sendTextMessage(
                session.token,
                session.userId,
                session.deviceId,
                recipientUserId,
                recipientPubKeyBytes,
                session.sharingPublicKeyBytes,
                text,
                sessionManager,
            );

            // Sync so the sent echo lands in IDB, then notify all subscribers
            // (including this hook's own onInboxUpdated listener).
            await syncAndPublish(session, sessionManager);
        } catch (error) {
            console.error('Failed to send message:', error);
            alert('Failed to send message. Please try again.');
        } finally {
            setSending(false);
        }
    };

    const sendMedia = async (file: File) => {
        if (sending || !sessionManager) return;

        setSending(true);
        try {
            let recipientUserId: string;
            let recipientPubKeyBytes: Uint8Array;

            if (isSaved) {
                recipientUserId = session.userId;
                recipientPubKeyBytes = session.sharingPublicKeyBytes;
            } else {
                if (!handle) throw new Error('No recipient handle');
                const resolveRes = await resolve(handle);
                recipientUserId = resolveRes.user_id;
                recipientPubKeyBytes = base64UrlDecode(
                    resolveRes.sharing_public_key,
                );
            }

            const enc = await encryptMedia(file);
            const { url } = await uploadMedia(
                session.token,
                session.userId,
                enc,
            );

            const envelope = JSON.stringify({
                type: 'media',
                body: file.name,
                file: {
                    url,
                    key: base64UrlEncode(enc.key),
                    iv: base64UrlEncode(enc.iv),
                    name: file.name,
                    size: file.size,
                },
            });

            await sendTextMessage(
                session.token,
                session.userId,
                session.deviceId,
                recipientUserId,
                recipientPubKeyBytes,
                session.sharingPublicKeyBytes,
                envelope,
                sessionManager,
            );

            await syncAndPublish(session, sessionManager);
        } catch (error) {
            console.error('Failed to send media:', error);
            alert('Failed to send attachment. Please try again.');
        } finally {
            setSending(false);
        }
    };

    return {
        messages,
        loading,
        sending,
        encryptionReady: !!sessionManager,
        chatTitle,
        sendMessage,
        sendMedia,
    };
}
