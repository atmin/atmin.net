import {
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

// Conversation-list preview: a typed payload reduced to one line (or "<photo>"),
// clamped so a long body never wraps past a single row.
function Preview({ text }: { text: string }) {
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
    userId: string;
    /** Navigate (forward View Transition) to a chat / settings route. */
    onOpen: (path: string) => void;
    onNewChat: (handle: string) => void;
}

export default function ChatsView({
    serverOk,
    conversations,
    contacts,
    displayNames,
    userId,
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
                        savedConv ? (
                            <Preview text={savedConv.lastMessageText} />
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
                            subtitle={<Preview text={conv.lastMessageText} />}
                            after={timeAgo(conv.lastMessageTimestamp)}
                            media={avatar('💬')}
                            onClick={() => onOpen(`/@${encodeURIComponent(h)}`)}
                        />
                    );
                })}
            </List>

            {dmConvs.length === 0 && (
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
