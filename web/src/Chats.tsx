import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { fetchMessages, storeGet } from './api';
import type { Session } from './auth';
import {
    loadAllContacts,
    loadConversations,
    type StoredConversation,
    saveContact,
    saveMessages,
} from './db';
import type { SessionManager } from './megolm-session';

interface Props {
    session: Session;
    sessionManager: SessionManager | null;
    onLogout: () => void;
}

function timeAgo(ts: number): string {
    const seconds = Math.floor((Date.now() - ts) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

export default function Chats({ session, sessionManager, onLogout }: Props) {
    const [copied, setCopied] = useState(false);
    const [serverOk, setServerOk] = useState<boolean | null>(null);
    const [handleInput, setHandleInput] = useState('');
    const [conversations, setConversations] = useState<StoredConversation[]>(
        [],
    );
    const [contacts, setContacts] = useState<Map<string, string>>(new Map());
    const navigate = useNavigate();

    useEffect(() => {
        fetch('/healthz')
            .then((r) => setServerOk(r.ok))
            .catch(() => setServerOk(false));
    }, []);

    // Load conversations + contacts from IndexedDB, then sync from server
    useEffect(() => {
        if (!sessionManager) return;

        const refresh = async () => {
            const [convs, contactMap] = await Promise.all([
                loadConversations(),
                loadAllContacts(),
            ]);
            setConversations(convs);
            setContacts(contactMap);

            // Resolve unknown peer handles from server profiles
            const unknownPeers: string[] = [];
            for (const conv of convs) {
                if (conv.conversationId.startsWith('self:')) continue;
                const parts = conv.conversationId.split(':');
                const peerUserId =
                    parts[1] === session.userId ? parts[2] : parts[1];
                if (!contactMap.has(peerUserId)) {
                    unknownPeers.push(peerUserId);
                }
            }
            if (unknownPeers.length > 0) {
                const resolved = new Map(contactMap);
                await Promise.all(
                    unknownPeers.map(async (uid) => {
                        try {
                            const buf = await storeGet(
                                session.token,
                                `users/${uid}/profile.json`,
                            );
                            const profile = JSON.parse(
                                new TextDecoder().decode(buf),
                            );
                            if (profile.invite_handle) {
                                resolved.set(uid, profile.invite_handle);
                                await saveContact(uid, profile.invite_handle);
                            }
                        } catch {
                            // Profile not found — keep userId fallback
                        }
                    }),
                );
                setContacts(resolved);
            }
        };

        // Show cached data immediately
        refresh();

        // Background sync: fetch all messages, save to DB, then refresh
        const sync = async () => {
            try {
                const synced = await fetchMessages(
                    session.token,
                    session.userId,
                    session.sharingPrivateKey,
                    sessionManager,
                );
                if (synced.length > 0) {
                    await saveMessages(session.userId, synced);
                    await refresh();
                }
            } catch (err) {
                console.error('Sync failed:', err);
            }
        };
        sync();

        // SSE: refresh on new messages
        const url = `/v1/events?token=${encodeURIComponent(session.token)}`;
        const events = new EventSource(url);
        events.addEventListener('new_message', () => {
            sync();
        });

        return () => events.close();
    }, [session, sessionManager]);

    const copyHandle = () => {
        navigator.clipboard.writeText(session.inviteHandle);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    // Split: saved messages on top, then DMs sorted by recency
    const savedConv = conversations.find((c) =>
        c.conversationId.startsWith('self:'),
    );
    const dmConvs = conversations.filter(
        (c) => !c.conversationId.startsWith('self:'),
    );

    // Extract peer handle from conversationId "dm:U1:U2"
    const peerHandle = (convId: string): string => {
        const parts = convId.split(':');
        const peerUserId = parts[1] === session.userId ? parts[2] : parts[1];
        return contacts.get(peerUserId) ?? peerUserId.slice(0, 8);
    };

    return (
        <div className="min-h-screen bg-stone-50 p-8 font-mono text-sm">
            <div className="mx-auto max-w-md">
                <div className="mb-8 flex items-center justify-between">
                    <h1 className="text-2xl font-bold">atmin</h1>
                    <div className="flex items-center gap-2">
                        <span
                            className={`inline-block h-2 w-2 rounded-full ${
                                serverOk === true
                                    ? 'bg-green-500'
                                    : serverOk === false
                                      ? 'bg-red-500'
                                      : 'bg-yellow-500'
                            }`}
                        />
                    </div>
                </div>

                <div className="mb-6 rounded bg-stone-100 p-4">
                    <p className="mb-1 text-xs text-stone-500">
                        Your invite handle
                    </p>
                    <div className="flex items-center justify-between">
                        <span className="text-lg">{session.inviteHandle}</span>
                        <button
                            type="button"
                            onClick={copyHandle}
                            className="text-xs text-stone-500 hover:text-stone-800"
                        >
                            {copied ? 'Copied' : 'Copy'}
                        </button>
                    </div>
                </div>

                {/* Chat list */}
                <div className="space-y-2">
                    {/* Saved Messages */}
                    <Link
                        to="/saved"
                        className="block rounded border border-stone-200 bg-white p-4 hover:bg-stone-50"
                    >
                        <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-100 text-stone-600">
                                📝
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="font-medium">
                                    Saved Messages
                                </div>
                                <div className="truncate text-xs text-stone-500">
                                    {savedConv
                                        ? savedConv.lastMessageText
                                        : 'Your private notes'}
                                </div>
                            </div>
                            {savedConv && (
                                <span className="shrink-0 text-xs text-stone-400">
                                    {timeAgo(savedConv.lastMessageTimestamp)}
                                </span>
                            )}
                        </div>
                    </Link>

                    {/* DM conversations */}
                    {dmConvs.map((conv) => {
                        const handle = peerHandle(conv.conversationId);
                        return (
                            <Link
                                key={conv.conversationId}
                                to={`/${encodeURIComponent(handle)}`}
                                className="block rounded border border-stone-200 bg-white p-4 hover:bg-stone-50"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-stone-100 text-stone-600">
                                        💬
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="font-medium">
                                            {handle}
                                        </div>
                                        <div className="truncate text-xs text-stone-500">
                                            {conv.lastMessageText}
                                        </div>
                                    </div>
                                    <span className="shrink-0 text-xs text-stone-400">
                                        {timeAgo(conv.lastMessageTimestamp)}
                                    </span>
                                </div>
                            </Link>
                        );
                    })}

                    {/* New chat */}
                    <form
                        onSubmit={(e) => {
                            e.preventDefault();
                            const h = handleInput.trim();
                            if (h) navigate(`/${encodeURIComponent(h)}`);
                        }}
                        className="flex gap-2"
                    >
                        <input
                            type="text"
                            value={handleInput}
                            onChange={(e) => setHandleInput(e.target.value)}
                            placeholder="Enter a handle..."
                            className="flex-1 rounded border border-stone-300 px-3 py-2 text-sm focus:border-stone-400 focus:outline-none"
                        />
                        <button
                            type="submit"
                            disabled={!handleInput.trim()}
                            className="rounded bg-stone-800 px-4 py-2 text-sm text-white hover:bg-stone-700 disabled:bg-stone-300"
                        >
                            Chat
                        </button>
                    </form>
                </div>

                <button
                    type="button"
                    onClick={onLogout}
                    className="mt-8 text-xs text-stone-400 hover:text-red-600"
                >
                    Sign out
                </button>
            </div>
        </div>
    );
}
