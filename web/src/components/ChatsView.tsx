import {
    Badge,
    Block,
    BlockTitle,
    Button,
    List,
    ListInput,
    ListItem,
    Navbar,
    Page,
    Sheet,
} from 'konsta/react';
import { Notebook, Settings as SettingsIcon, SquarePen } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import type { StoredConversation } from '@/lib/db';
import { messagePreview } from '@/lib/payload';

// Conversation-list preview, clamped to a single row. An unsent draft wins (red
// "Draft:" prefix, as other messengers show); else a deleted latest message
// renders a muted italic "[deleted]" mirroring the in-chat placeholder; else the
// typed payload reduced to one line (or "<photo>").
function Preview({
    text,
    deleted,
    draft,
}: {
    text: string;
    deleted?: boolean;
    draft?: string;
}) {
    if (draft) {
        return (
            <span className="line-clamp-1" data-testid="conversation-preview">
                <span className="text-destructive">Draft:</span>{' '}
                {draft.replace(/\s+/g, ' ').trim()}
            </span>
        );
    }
    if (deleted) {
        return (
            <span
                className="line-clamp-1 italic opacity-50"
                data-testid="conversation-preview"
            >
                [deleted]
            </span>
        );
    }
    return (
        <span className="line-clamp-1" data-testid="conversation-preview">
            {messagePreview(text)}
        </span>
    );
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

const avatar = (content: ReactNode) => (
    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/5 text-lg dark:bg-white/10">
        {content}
    </span>
);

interface Props {
    serverOk: boolean | null;
    conversations: StoredConversation[];
    contacts: Map<string, string>;
    displayNames: Map<string, string>;
    /** Per-conversation unread incoming-message count (ADR-0026); omits zeros. */
    unread?: Map<string, number>;
    /** Unsent drafts keyed by conversation handle ("saved" for Saved Messages). */
    drafts?: Map<string, string>;
    userId: string;
    /**
     * False until the first IndexedDB read resolves. Gates the empty state so a
     * populated account never flashes "No conversations yet" on reload while the
     * local read is in flight.
     */
    hydrated: boolean;
    /** Navigate (forward View Transition) to a chat / settings route. */
    onOpen: (path: string) => void;
    onNewChat: (handle: string) => void;
}

export default function ChatsView({
    serverOk,
    conversations,
    contacts,
    displayNames,
    unread = new Map(),
    drafts = new Map(),
    userId,
    hydrated,
    onOpen,
    onNewChat,
}: Props) {
    const [composeOpen, setComposeOpen] = useState(false);
    const [handleInput, setHandleInput] = useState('');

    // Server reachability — the colored dot on the wordmark. Distinct from the
    // device network status (OfflineIndicator). Color-only needs a label.
    const serverLabel =
        serverOk === true
            ? 'Server online'
            : serverOk === false
              ? 'Server offline'
              : 'Connecting to server';
    const serverDot =
        serverOk === true
            ? 'bg-green-500'
            : serverOk === false
              ? 'bg-red-500'
              : 'bg-yellow-500';

    // Saved Messages on top, then DMs sorted by recency (already sorted upstream).
    const savedConv = conversations.find((c) =>
        c.conversationId.startsWith('self:'),
    );
    const savedDraft = drafts.get('saved');
    const dmConvs = conversations.filter(
        (c) => !c.conversationId.startsWith('self:'),
    );

    // Extract peer userId from conversationId "dm:U1:U2".
    const peerId = (convId: string): string => {
        const parts = convId.split(':');
        return parts[1] === userId ? parts[2] : parts[1];
    };
    const peerHandle = (uid: string) => contacts.get(uid) ?? uid.slice(0, 8);
    const peerLabel = (uid: string) => displayNames.get(uid) || peerHandle(uid);

    // Right-aligned row meta: last-activity time, with an unread count badge
    // beneath it when the conversation has unseen incoming messages (ADR-0026).
    const rowAfter = (conv: StoredConversation) => {
        const n = unread.get(conv.conversationId) ?? 0;
        return (
            <span className="flex flex-col items-end gap-1">
                <span>{timeAgo(conv.lastMessageTimestamp)}</span>
                {n > 0 && (
                    <span data-testid="unread-badge">
                        <Badge className="bg-primary!">
                            {n > 99 ? '99+' : n}
                        </Badge>
                    </span>
                )}
            </span>
        );
    };

    const startChat = () => {
        const h = handleInput.trim();
        if (!h) return;
        onNewChat(h);
        setComposeOpen(false);
        setHandleInput('');
    };

    const title = (
        <span className="flex items-center justify-center gap-1.5 font-semibold">
            atmin
            <span
                role="img"
                aria-label={serverLabel}
                title={serverLabel}
                className={`inline-block h-2 w-2 rounded-full ${serverDot}`}
            />
        </span>
    );

    // Plain buttons (not Konsta `Link`, which hardcodes role="link") — these are
    // controls: compose opens a sheet, the gear navigates programmatically. Keeps
    // correct button semantics + accessible names for the e2e selectors.
    const navbarRight = (
        <div className="flex items-center">
            <button
                type="button"
                aria-label="New chat"
                onClick={() => setComposeOpen(true)}
                className="flex h-10 w-10 items-center justify-center active:opacity-60"
            >
                <SquarePen className="h-5 w-5" />
            </button>
            <button
                type="button"
                aria-label="Settings"
                onClick={() => onOpen('/settings')}
                className="flex h-10 w-10 items-center justify-center active:opacity-60"
            >
                <SettingsIcon className="h-5 w-5" />
            </button>
        </div>
    );

    return (
        <Page>
            <Navbar title={title} right={navbarRight} />

            <List strong inset>
                <ListItem
                    link
                    title="Saved Messages"
                    subtitle={
                        savedConv || savedDraft ? (
                            <Preview
                                text={savedConv?.lastMessageText ?? ''}
                                deleted={savedConv?.lastMessageDeleted}
                                draft={savedDraft}
                            />
                        ) : (
                            'Your private notes'
                        )
                    }
                    after={
                        savedConv
                            ? timeAgo(savedConv.lastMessageTimestamp)
                            : undefined
                    }
                    media={avatar(<Notebook className="h-5 w-5" />)}
                    onClick={() => onOpen('/saved')}
                />
                {dmConvs.map((conv) => {
                    const uid = peerId(conv.conversationId);
                    const h = peerHandle(uid);
                    return (
                        <ListItem
                            key={conv.conversationId}
                            link
                            title={peerLabel(uid)}
                            subtitle={
                                <Preview
                                    text={conv.lastMessageText}
                                    deleted={conv.lastMessageDeleted}
                                    draft={drafts.get(h)}
                                />
                            }
                            after={rowAfter(conv)}
                            media={avatar('💬')}
                            onClick={() => onOpen(`/@${encodeURIComponent(h)}`)}
                        />
                    );
                })}
            </List>

            {hydrated && dmConvs.length === 0 && (
                <Block className="text-center text-sm opacity-60">
                    No conversations yet — tap the compose button to start one.
                </Block>
            )}

            <Sheet
                opened={composeOpen}
                onBackdropClick={() => setComposeOpen(false)}
                className="w-full pb-8"
            >
                <BlockTitle>New chat</BlockTitle>
                <List strong inset>
                    <ListInput
                        type="text"
                        placeholder="Enter a handle..."
                        value={handleInput}
                        onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                            setHandleInput(e.target.value)
                        }
                    />
                </List>
                <Block className="flex gap-3">
                    <Button rounded clear onClick={() => setComposeOpen(false)}>
                        Cancel
                    </Button>
                    <Button
                        rounded
                        onClick={startChat}
                        disabled={!handleInput.trim()}
                    >
                        Start chat
                    </Button>
                </Block>
            </Sheet>
        </Page>
    );
}
