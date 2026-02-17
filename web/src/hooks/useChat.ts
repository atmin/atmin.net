import { useEffect, useState } from 'react';
import {
    conversationId,
    fetchMessages,
    resolve,
    sendTextMessage,
} from '@/lib/api';
import type { Session } from '@/lib/auth';
import {
    loadMessages as loadFromDB,
    saveContact,
    saveMessages,
} from '@/lib/db';
import type { SessionManager } from '@/lib/megolm-session';

export interface Message {
    id: string;
    text: string;
    timestamp: Date;
}

// Merge newly synced messages into existing state.
// Keeps previously-decrypted messages that may fail re-decryption
// (Megolm ratchet only goes forward), adds new ones.
function mergeMessages(existing: Message[], synced: Message[]): Message[] {
    const byId = new Map(existing.map((m) => [m.id, m]));
    for (const m of synced) byId.set(m.id, m);
    return [...byId.values()].sort(
        (a, b) => a.timestamp.getTime() - b.timestamp.getTime(),
    );
}

export interface ChatState {
    messages: Message[];
    loading: boolean;
    sending: boolean;
    encryptionReady: boolean;
    chatTitle: string;
    sendMessage: (text: string) => Promise<void>;
}

export function useChat(
    handle: string | undefined,
    session: Session,
    sessionManager: SessionManager | null,
): ChatState {
    const isSaved = handle === 'saved';
    const chatTitle = isSaved ? 'Saved Messages' : (handle ?? '');

    const [messages, setMessages] = useState<Message[]>([]);
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(true);
    const [convId, setConvId] = useState<string | null>(null);

    // Resolve conversation ID from handle
    useEffect(() => {
        if (isSaved) {
            setConvId(conversationId(session.userId, session.userId));
            return;
        }
        if (!handle) return;

        resolve(handle).then((res) => {
            saveContact(res.user_id, handle);
            setConvId(conversationId(session.userId, res.user_id));
        });
    }, [handle, isSaved, session.userId]);

    // Load messages on mount: IndexedDB first (instant), then sync from server
    useEffect(() => {
        if (!convId) return;

        const loadAndSync = async () => {
            try {
                // Load from IndexedDB first (instant)
                const cached = await loadFromDB(session.userId);
                const filtered = cached.filter(
                    (m) => m.conversationId === convId,
                );
                if (filtered.length > 0) {
                    setMessages(
                        filtered.map((m) => ({
                            id: m.id,
                            text: m.text,
                            timestamp: new Date(m.timestamp),
                        })),
                    );
                    setLoading(false);
                }

                // Fetch from server (source of truth)
                const synced = await fetchMessages(
                    session.token,
                    session.userId,
                    session.sharingPrivateKey,
                    sessionManager ?? undefined,
                );

                // Filter to this conversation
                const convMessages = synced.filter(
                    (m) => m.conversationId === convId,
                );

                // Merge with existing (Megolm ratchet may skip already-decrypted)
                setMessages((prev) => mergeMessages(prev, convMessages));

                // Save ALL messages to IndexedDB (not just this conversation)
                await saveMessages(session.userId, synced);
            } catch (error) {
                console.error('Failed to load messages:', error);
            } finally {
                setLoading(false);
            }
        };

        loadAndSync();
    }, [
        convId,
        session.token,
        session.userId,
        session.sharingPrivateKey,
        sessionManager,
    ]);

    // Real-time sync via Server-Sent Events
    useEffect(() => {
        if (!convId) return;

        const url = `/v1/events?token=${encodeURIComponent(session.token)}`;
        const events = new EventSource(url);

        events.addEventListener('new_message', async () => {
            try {
                const synced = await fetchMessages(
                    session.token,
                    session.userId,
                    session.sharingPrivateKey,
                    sessionManager ?? undefined,
                );
                const convMessages = synced.filter(
                    (m) => m.conversationId === convId,
                );
                setMessages((prev) => mergeMessages(prev, convMessages));
                await saveMessages(session.userId, synced);
            } catch (error) {
                console.error('Failed to sync on SSE notification:', error);
            }
        });

        events.onerror = () => {
            console.error('SSE connection error');
            events.close();
        };

        return () => events.close();
    }, [
        convId,
        session.token,
        session.userId,
        session.sharingPrivateKey,
        sessionManager,
    ]);

    const sendMessage = async (text: string) => {
        if (!text || sending || !sessionManager) return;

        setSending(true);
        try {
            // Determine recipient
            let recipientUserId: string;
            let recipientPubKeyBytes: Uint8Array;

            if (isSaved) {
                recipientUserId = session.userId;
                recipientPubKeyBytes = session.sharingPublicKeyBytes;
            } else {
                if (!handle) throw new Error('No recipient handle');
                const resolveRes = await resolve(handle);
                recipientUserId = resolveRes.user_id;
                const pubKeyB64 = resolveRes.sharing_public_key;
                const { base64UrlDecode } = await import('@/lib/crypto');
                recipientPubKeyBytes = base64UrlDecode(pubKeyB64);
            }

            // Send encrypted message
            if (sessionManager) {
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
            }

            // Refetch messages to show the sent message
            const synced = await fetchMessages(
                session.token,
                session.userId,
                session.sharingPrivateKey,
                sessionManager ?? undefined,
            );

            const convMessages = synced.filter(
                (m) => m.conversationId === convId,
            );
            setMessages((prev) => mergeMessages(prev, convMessages));
            await saveMessages(session.userId, synced);
        } catch (error) {
            console.error('Failed to send message:', error);
            alert('Failed to send message. Please try again.');
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
    };
}
