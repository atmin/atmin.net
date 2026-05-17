import { useEffect, useState } from 'react';
import { resolve } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { uploadContacts } from '@/lib/contact-backup';
import { base64UrlDecode } from '@/lib/crypto';
import { loadMessages as loadFromDB, saveContact } from '@/lib/db';
import { onInboxUpdated } from '@/lib/inbox-sync';
import type { MediaFile } from '@/lib/media';
import type { SessionManager } from '@/lib/megolm-session';
import { conversationId } from '@/lib/messaging';
import { useChatSend } from './useChatSend';

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
    const [loading, setLoading] = useState(true);
    const [convId, setConvId] = useState<string | null>(null);
    const [chatTitle, setChatTitle] = useState(
        isSaved ? 'Saved Messages' : (handle ?? ''),
    );

    const { sending, sendText, sendMedia } = useChatSend(
        handle,
        isSaved,
        session,
        sessionManager,
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

        refresh();
        return onInboxUpdated(refresh);
    }, [convId, session.userId]);

    return {
        messages,
        loading,
        sending,
        encryptionReady: !!sessionManager,
        chatTitle,
        sendMessage: sendText,
        sendMedia,
    };
}
