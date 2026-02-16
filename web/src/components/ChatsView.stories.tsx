import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import ChatsView from './ChatsView';

const meta = {
    title: 'Chat/ChatsView',
    component: ChatsView,
    args: {
        onNewChat: fn(),
        onLogout: fn(),
    },
} satisfies Meta<typeof ChatsView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
    args: {
        inviteHandle: 'copper-falcon',
        serverOk: true,
        conversations: [],
        contacts: new Map(),
        userId: '01USER123',
    },
};

export const WithConversations: Story = {
    args: {
        inviteHandle: 'copper-falcon',
        serverOk: true,
        conversations: [
            {
                conversationId: 'dm:01USER123:01OTHER456',
                lastMessageText: 'See you tomorrow!',
                lastMessageTimestamp: Date.now() - 1000 * 60 * 5,
                messageCount: 12,
            },
            {
                conversationId: 'dm:01USER123:01ALICE789',
                lastMessageText: 'The encryption looks solid.',
                lastMessageTimestamp: Date.now() - 1000 * 60 * 60 * 2,
                messageCount: 45,
            },
            {
                conversationId: 'self:01USER123',
                lastMessageText: 'Remember to review the key backup code',
                lastMessageTimestamp: Date.now() - 1000 * 60 * 60 * 24,
                messageCount: 7,
            },
        ],
        contacts: new Map([
            ['01OTHER456', 'silver-hawk'],
            ['01ALICE789', 'gentle-breeze'],
        ]),
        userId: '01USER123',
    },
};

export const ServerDown: Story = {
    args: {
        inviteHandle: 'copper-falcon',
        serverOk: false,
        conversations: [],
        contacts: new Map(),
        userId: '01USER123',
    },
};

export const ServerConnecting: Story = {
    args: {
        inviteHandle: 'copper-falcon',
        serverOk: null,
        conversations: [],
        contacts: new Map(),
        userId: '01USER123',
    },
};
