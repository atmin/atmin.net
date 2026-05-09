import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { StoredConversation } from '@/lib/db';
import Layout from './Layout';
import Logo from './Logo';

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

interface Props {
    handle: string;
    serverOk: boolean | null;
    conversations: StoredConversation[];
    contacts: Map<string, string>;
    displayNames: Map<string, string>;
    userId: string;
    onNewChat: (handle: string) => void;
    onLogout: () => void;
}

export default function ChatsView({
    handle,
    serverOk,
    conversations,
    contacts,
    displayNames,
    userId,
    onNewChat,
    onLogout,
}: Props) {
    const [copied, setCopied] = useState(false);
    const [handleInput, setHandleInput] = useState('');

    const copyHandle = () => {
        navigator.clipboard.writeText(handle);
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

    // Extract peer userId from conversationId "dm:U1:U2"
    const peerId = (convId: string): string => {
        const parts = convId.split(':');
        return parts[1] === userId ? parts[2] : parts[1];
    };
    const peerHandle = (uid: string) => contacts.get(uid) ?? uid.slice(0, 8);
    const peerLabel = (uid: string) => displayNames.get(uid) || peerHandle(uid);

    const topBar = (
        <div className="mx-auto flex w-full max-w-2xl items-center justify-between font-mono">
            <div className="flex items-center gap-2">
                <Logo className="h-7 w-7" />
                <span className="font-bold">atmin</span>
            </div>
            <div className="flex items-center gap-2">
                <Link
                    to="/settings"
                    className="text-xs text-muted-foreground hover:text-foreground"
                >
                    Settings
                </Link>
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
    );

    return (
        <Layout topBar={topBar}>
            <div className="mx-auto max-w-2xl px-8 pb-8 pt-20 font-mono text-sm">
                <div className="mb-6 rounded bg-muted p-4">
                    <p className="mb-1 text-xs text-muted-foreground">
                        Your handle
                    </p>
                    <div className="flex items-center justify-between">
                        <span className="text-lg">{handle}</span>
                        <button
                            type="button"
                            onClick={copyHandle}
                            className="text-xs text-muted-foreground hover:text-foreground"
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
                        className="block rounded border border-border bg-card p-4 hover:bg-accent"
                    >
                        <div className="flex items-center gap-3">
                            <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                📝
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="font-medium">
                                    Saved Messages
                                </div>
                                <div className="truncate text-xs text-muted-foreground">
                                    {savedConv
                                        ? savedConv.lastMessageText
                                        : 'Your private notes'}
                                </div>
                            </div>
                            {savedConv && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {timeAgo(savedConv.lastMessageTimestamp)}
                                </span>
                            )}
                        </div>
                    </Link>

                    {/* DM conversations */}
                    {dmConvs.map((conv) => {
                        const uid = peerId(conv.conversationId);
                        const handle = peerHandle(uid);
                        const label = peerLabel(uid);
                        return (
                            <Link
                                key={conv.conversationId}
                                to={`/${encodeURIComponent(handle)}`}
                                className="block rounded border border-border bg-card p-4 hover:bg-accent"
                            >
                                <div className="flex items-center gap-3">
                                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-muted text-muted-foreground">
                                        💬
                                    </div>
                                    <div className="min-w-0 flex-1">
                                        <div className="font-medium">
                                            {label}
                                        </div>
                                        <div className="truncate text-xs text-muted-foreground">
                                            {conv.lastMessageText}
                                        </div>
                                    </div>
                                    <span className="shrink-0 text-xs text-muted-foreground">
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
                            if (h) onNewChat(h);
                        }}
                        className="flex gap-2"
                    >
                        <input
                            type="text"
                            value={handleInput}
                            onChange={(e) => setHandleInput(e.target.value)}
                            placeholder="Enter a handle..."
                            className="flex-1 rounded border border-input bg-background px-3 py-2 text-sm focus:border-ring focus:outline-none"
                        />
                        <button
                            type="submit"
                            disabled={!handleInput.trim()}
                            className="rounded bg-primary px-4 py-2 text-sm text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                        >
                            Chat
                        </button>
                    </form>
                </div>

                <button
                    type="button"
                    onClick={onLogout}
                    className="mt-8 text-xs text-muted-foreground hover:text-destructive"
                >
                    Sign out
                </button>
            </div>
        </Layout>
    );
}
