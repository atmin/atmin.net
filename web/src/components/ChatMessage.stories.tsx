import type { Meta, StoryObj } from '@storybook/react-vite';
import ChatMessage from './ChatMessage';

const meta = {
    title: 'Chat/ChatMessage',
    component: ChatMessage,
} satisfies Meta<typeof ChatMessage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Sent: Story = {
    args: {
        text: 'Hey, how are you?',
        timestamp: new Date('2025-01-15T14:30:00'),
        sent: true,
    },
};

export const Received: Story = {
    args: {
        text: "I'm doing great, thanks for asking!",
        timestamp: new Date('2025-01-15T14:31:00'),
        sent: false,
    },
};

export const NoTimestamp: Story = {
    args: {
        text: 'Message with no timestamp',
        timestamp: new Date(0),
        sent: false,
    },
};

// --- Media variants ---
// These render MediaAttachment, which performs a real fetch; in Storybook
// (no server) the fetch fails and the component surfaces `network-error` or
// `unavailable`. The stories exist to exercise layout across states.

const fakeMedia = {
    url: 'media/01STORY/fixture',
    key: new Uint8Array(32),
    iv: new Uint8Array(12),
    name: 'fixture.png',
    size: 12_345,
};

export const MediaImage: Story = {
    args: {
        text: 'Check out this photo',
        timestamp: new Date('2025-01-15T14:32:00'),
        sent: false,
        media: fakeMedia,
        token: 'fake-token',
    },
};

export const MediaDownload: Story = {
    args: {
        text: 'Here is a file',
        timestamp: new Date('2025-01-15T14:33:00'),
        sent: true,
        media: { ...fakeMedia, name: 'report.bin', size: 98_765 },
        token: 'fake-token',
    },
};

export const MediaCorrupt: Story = {
    args: {
        text: '',
        timestamp: new Date('2025-01-15T14:34:00'),
        sent: false,
        media: fakeMedia,
        token: 'fake-token',
    },
};

export const MediaUnavailable: Story = {
    args: {
        text: 'missing.jpg',
        timestamp: new Date('2025-01-15T14:35:00'),
        sent: false,
        media: fakeMedia,
        token: 'fake-token',
    },
};

export const MediaLoading: Story = {
    args: {
        text: 'loading.png',
        timestamp: new Date('2025-01-15T14:36:00'),
        sent: false,
        media: fakeMedia,
        token: 'fake-token',
    },
};
