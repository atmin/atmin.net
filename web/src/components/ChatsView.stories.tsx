import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import ChatsView from './ChatsView';

const meta = {
    title: 'Chat/ChatsView',
    component: ChatsView,
    parameters: { layout: 'fullscreen' },
    args: {
        onNewChat: fn(),
        onOpen: fn(),
    },
} satisfies Meta<typeof ChatsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
    args: {
        serverOk: true,
        conversations: [],
        contacts: new Map(),
        displayNames: new Map(),
        userId: '01USER123',
    },
};

export const WithConversations: Story = {
    args: {
        serverOk: true,
        conversations: [
            {
                conversationId: 'dm:01USER123:01OTHER456',
                // Typed text envelope (the wire format) — the preview shows the
                // body, not the raw JSON.
                lastMessageText: JSON.stringify({
                    type: 'text',
                    body: 'See you tomorrow!',
                }),
                lastMessageTimestamp: Date.now() - 1000 * 60 * 5,
                messageCount: 12,
            },
            {
                conversationId: 'dm:01USER123:01ALICE789',
                // A media message previews as "<photo>".
                lastMessageText: JSON.stringify({
                    type: 'media',
                    body: 'sunset.jpg',
                    file: {
                        url: 'media/01OTHER/x',
                        key: 'k',
                        iv: 'i',
                        name: 'sunset.jpg',
                        size: 482_113,
                        mime: 'image/jpeg',
                    },
                }),
                lastMessageTimestamp: Date.now() - 1000 * 60 * 60 * 2,
                messageCount: 45,
            },
            {
                conversationId: 'self:01USER123',
                // A long body is clamped to a single line with an ellipsis.
                lastMessageText: JSON.stringify({
                    type: 'text',
                    body: 'Remember to review the key backup code before the audit, and double-check the rotation schedule for next week as well',
                }),
                lastMessageTimestamp: Date.now() - 1000 * 60 * 60 * 24,
                messageCount: 7,
            },
        ],
        contacts: new Map([
            ['01OTHER456', 'silver-hawk'],
            ['01ALICE789', 'gentle-breeze'],
        ]),
        displayNames: new Map([['01ALICE789', 'Alice Wonderland']]),
        userId: '01USER123',
    },
};

export const ServerDown: Story = {
    args: {
        serverOk: false,
        conversations: [],
        contacts: new Map(),
        displayNames: new Map(),
        userId: '01USER123',
    },
};

export const ServerConnecting: Story = {
    args: {
        serverOk: null,
        conversations: [],
        contacts: new Map(),
        displayNames: new Map(),
        userId: '01USER123',
    },
};
