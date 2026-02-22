import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import ChatView from './ChatView';

const meta = {
    title: 'Chat/ChatView',
    component: ChatView,
    args: {
        onSend: fn(),
        encryptionReady: true,
    },
} satisfies Meta<typeof ChatView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [],
        loading: false,
        sending: false,
    },
};

export const SavedEmpty: Story = {
    args: {
        chatTitle: 'Saved Messages',
        isSaved: true,
        handle: 'saved',
        messages: [],
        loading: false,
        sending: false,
    },
};

export const Loading: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [],
        loading: true,
        sending: false,
    },
};

export const WithMessages: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'Hey, how are you?',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: false,
            },
            {
                id: '2',
                text: "I'm doing great! Working on the new encryption feature.",
                timestamp: new Date('2024-01-15T10:31:00Z'),
                sent: true,
            },
            {
                id: '3',
                text: 'Nice, sounds exciting. Let me know if you need help testing.',
                timestamp: new Date('2024-01-15T10:32:00Z'),
                sent: false,
            },
        ],
        loading: false,
        sending: false,
    },
};

export const Sending: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'Hello!',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: true,
            },
        ],
        loading: false,
        sending: true,
    },
};
