import {
    App,
    Block,
    BlockTitle,
    Button,
    List,
    ListInput,
    ListItem,
    Navbar,
    Page,
    Segmented,
    SegmentedButton,
} from 'konsta/react';
import { useState } from 'react';
import type { KonstaTheme } from '@/hooks/useKonstaTheme';
import type { StoredConversation } from '@/lib/db';

// Konsta UI spike (tasks/konsta-ui-spike.md) — the conversation list rebuilt
// with Konsta components to evaluate iOS/Material feel under Tailwind v4. Mixes
// Konsta components with plain Tailwind elements (the navbar dot/settings) to
// exercise the coexistence question (Q6). Throwaway; not the production screen.

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

const avatar = (emoji: string) => (
    <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/5 text-lg dark:bg-white/10">
        {emoji}
    </span>
);

interface Props {
    handle: string;
    serverOk: boolean | null;
    conversations: StoredConversation[];
    contacts: Map<string, string>;
    displayNames: Map<string, string>;
    userId: string;
    theme: KonstaTheme;
    setTheme: (t: KonstaTheme) => void;
    onOpen: (path: string) => void;
    onNewChat: (handle: string) => void;
    onLogout: () => void;
}

export default function ChatsViewKonsta({
    handle,
    serverOk,
    conversations,
    contacts,
    displayNames,
    userId,
    theme,
    setTheme,
    onOpen,
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

    const savedConv = conversations.find((c) =>
        c.conversationId.startsWith('self:'),
    );
    const dmConvs = conversations.filter(
        (c) => !c.conversationId.startsWith('self:'),
    );
    const peerId = (convId: string): string => {
        const parts = convId.split(':');
        return parts[1] === userId ? parts[2] : parts[1];
    };
    const peerHandle = (uid: string) => contacts.get(uid) ?? uid.slice(0, 8);
    const peerLabel = (uid: string) => displayNames.get(uid) || peerHandle(uid);

    const navbarRight = (
        <div className="flex items-center gap-3 pr-1">
            <button
                type="button"
                onClick={() => onOpen('/settings')}
                className="text-sm opacity-70 active:opacity-100"
            >
                Settings
            </button>
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
    );

    return (
        <App theme={theme} safeAreas={false} className="h-full">
            <Page>
                <Navbar title="atmin" right={navbarRight} />

                {/* Spike-only: live theme toggle to compare iOS vs Material. */}
                <Block strong inset className="space-y-0">
                    <Segmented strong>
                        <SegmentedButton
                            active={theme === 'ios'}
                            onClick={() => setTheme('ios')}
                        >
                            iOS
                        </SegmentedButton>
                        <SegmentedButton
                            active={theme === 'material'}
                            onClick={() => setTheme('material')}
                        >
                            Material
                        </SegmentedButton>
                    </Segmented>
                </Block>

                <BlockTitle>Your handle</BlockTitle>
                <List strong inset>
                    <ListItem
                        title={handle}
                        after={
                            <Button clear small onClick={copyHandle}>
                                {copied ? 'Copied' : 'Copy'}
                            </Button>
                        }
                    />
                </List>

                <BlockTitle>Chats</BlockTitle>
                <List strong inset>
                    <ListItem
                        link
                        title="Saved Messages"
                        subtitle={
                            savedConv
                                ? savedConv.lastMessageText
                                : 'Your private notes'
                        }
                        after={
                            savedConv
                                ? timeAgo(savedConv.lastMessageTimestamp)
                                : undefined
                        }
                        media={avatar('📝')}
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
                                subtitle={conv.lastMessageText}
                                after={timeAgo(conv.lastMessageTimestamp)}
                                media={avatar('💬')}
                                onClick={() =>
                                    onOpen(`/@${encodeURIComponent(h)}`)
                                }
                            />
                        );
                    })}
                </List>

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
                <Block className="space-y-4">
                    <Button
                        onClick={() => {
                            const h = handleInput.trim();
                            if (h) onNewChat(h);
                        }}
                        disabled={!handleInput.trim()}
                    >
                        Chat
                    </Button>
                    <Button clear onClick={onLogout}>
                        Sign out
                    </Button>
                </Block>
            </Page>
        </App>
    );
}
