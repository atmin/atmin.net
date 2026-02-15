import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchMessages, resolve, sendTextMessage } from './api';
import type { Session } from './auth';
import { loadMessages as loadFromDB, saveMessages } from './db';
import { backupSessionKey } from './key-backup';
import type { SessionManager } from './megolm-session';

interface Message {
    id: string;
    text: string;
    timestamp: Date;
}

interface Props {
    session: Session;
    sessionManager: SessionManager | null;
}

export default function Chat({ session, sessionManager }: Props) {
    const { handle } = useParams<{ handle: string }>();
    const isSaved = handle === 'saved';
    const chatTitle = isSaved ? 'Saved Messages' : handle;

    const [messages, setMessages] = useState<Message[]>([]);
    const [inputValue, setInputValue] = useState('');
    const [sending, setSending] = useState(false);
    const [loading, setLoading] = useState(true);

    // Load messages on mount: IndexedDB first (instant), then sync from server
    useEffect(() => {
        const loadAndSync = async () => {
            try {
                // Load from IndexedDB first (instant)
                const cached = await loadFromDB(session.userId);
                if (cached.length > 0) {
                    setMessages(
                        cached.map((m) => ({
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

                // Update state with server messages
                setMessages(synced);

                // Save to IndexedDB
                await saveMessages(session.userId, synced);
            } catch (error) {
                console.error('Failed to load messages:', error);
            } finally {
                setLoading(false);
            }
        };

        loadAndSync();
    }, [
        session.token,
        session.userId,
        session.sharingPrivateKey,
        sessionManager,
    ]);

    // Real-time sync via Server-Sent Events
    useEffect(() => {
        // EventSource doesn't support custom headers, so pass token as query param
        const url = `/v1/events?token=${encodeURIComponent(session.token)}`;
        const events = new EventSource(url);

        events.addEventListener('new_message', async () => {
            // Sync messages when notified
            try {
                const synced = await fetchMessages(
                    session.token,
                    session.userId,
                    session.sharingPrivateKey,
                    sessionManager ?? undefined,
                );
                setMessages(synced);
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
        session.token,
        session.userId,
        session.sharingPrivateKey,
        sessionManager,
    ]);

    const handleSend = async (e: React.FormEvent) => {
        e.preventDefault();
        const text = inputValue.trim();
        if (!text || sending) return;

        setSending(true);
        try {
            // Determine recipient
            let recipientUserId: string;
            let recipientPubKeyBytes: Uint8Array;

            if (isSaved) {
                // Sending to yourself
                recipientUserId = session.userId;
                recipientPubKeyBytes = session.sharingPublicKeyBytes;
            } else {
                // Sending to another user
                if (!handle) throw new Error('No recipient handle');
                const resolveRes = await resolve(handle);
                recipientUserId = resolveRes.user_id;
                // Decode base64url public key
                const pubKeyB64 = resolveRes.sharing_public_key;
                const { base64UrlDecode } = await import('./crypto');
                recipientPubKeyBytes = base64UrlDecode(pubKeyB64);
            }

            // Send encrypted message
            if (sessionManager) {
                const { isNewSession } = await sendTextMessage(
                    session.token,
                    session.userId,
                    session.deviceId,
                    recipientUserId,
                    recipientPubKeyBytes,
                    text,
                    sessionManager,
                );

                // Back up new session key
                if (isNewSession) {
                    const [outbound] = await sessionManager.getOutbound();
                    await backupSessionKey(
                        session.token,
                        session.userId,
                        outbound.session_id,
                        outbound.session_key(),
                        session.backupKey,
                    );
                }
            }

            // Refetch messages to show the sent message
            const synced = await fetchMessages(
                session.token,
                session.userId,
                session.sharingPrivateKey,
                sessionManager ?? undefined,
            );

            // Update state and IndexedDB
            setMessages(synced);
            await saveMessages(session.userId, synced);
            setInputValue('');
        } catch (error) {
            console.error('Failed to send message:', error);
            alert('Failed to send message. Please try again.');
        } finally {
            setSending(false);
        }
    };

    return (
        <div className="flex min-h-screen flex-col bg-stone-50">
            {/* Header */}
            <div className="border-b border-stone-200 bg-white px-4 py-3">
                <div className="mx-auto flex max-w-2xl items-center gap-3">
                    <Link
                        to="/"
                        className="text-stone-400 hover:text-stone-600"
                    >
                        ← Back
                    </Link>
                    <h2 className="font-mono text-sm font-medium">
                        {chatTitle}
                    </h2>
                </div>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto max-w-2xl p-4">
                    {loading ? (
                        <div className="flex h-96 items-center justify-center text-stone-400">
                            <div className="text-center">
                                <p>Loading messages...</p>
                            </div>
                        </div>
                    ) : messages.length === 0 ? (
                        <div className="flex h-96 items-center justify-center rounded border border-dashed border-stone-300 text-center text-stone-400">
                            <div>
                                <p className="mb-2">No messages yet</p>
                                <p className="text-xs">
                                    {isSaved
                                        ? 'Send yourself notes and reminders'
                                        : `Start a conversation with ${handle}`}
                                </p>
                            </div>
                        </div>
                    ) : (
                        <div className="space-y-3">
                            {messages.map((msg) => (
                                <div
                                    key={msg.id}
                                    className="rounded bg-white p-3 shadow-sm"
                                >
                                    <p className="text-sm">{msg.text}</p>
                                    <p className="mt-1 text-xs text-stone-400">
                                        {msg.timestamp.getTime() === 0
                                            ? 'No timestamp'
                                            : msg.timestamp.toLocaleTimeString()}
                                    </p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </div>

            {/* Message input */}
            <div className="border-t border-stone-200 bg-white px-4 py-3">
                <form
                    onSubmit={handleSend}
                    className="mx-auto flex max-w-2xl gap-2"
                >
                    <input
                        type="text"
                        value={inputValue}
                        onChange={(e) => setInputValue(e.target.value)}
                        placeholder="Type a message..."
                        className="flex-1 rounded border border-stone-300 px-3 py-2 text-sm focus:border-stone-400 focus:outline-none"
                    />
                    <button
                        type="submit"
                        disabled={!inputValue.trim() || sending}
                        className="rounded bg-stone-800 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:bg-stone-300"
                    >
                        {sending ? 'Sending...' : 'Send'}
                    </button>
                </form>
            </div>
        </div>
    );
}
