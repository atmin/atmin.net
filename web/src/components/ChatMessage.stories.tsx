import type { Meta, StoryObj } from '@storybook/react-vite';
import type { MediaState } from '@/hooks/useMedia';
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

const fakeMedia = {
    url: 'media/01STORY/fixture',
    key: new Uint8Array(32),
    iv: new Uint8Array(12),
    name: 'fixture.png',
    size: 12_345,
};

const state = (s: MediaState): MediaState => s;
const noop = () => {};

export const MediaImage: Story = {
    args: {
        text: 'Check out this photo',
        timestamp: new Date('2025-01-15T14:32:00'),
        sent: false,
        media: fakeMedia,
        mediaState: state({
            status: 'network-error',
            blobUrl: null,
            mime: null,
        }),
        onMediaRetry: noop,
    },
};

export const MediaDownload: Story = {
    args: {
        text: 'Here is a file',
        timestamp: new Date('2025-01-15T14:33:00'),
        sent: true,
        media: { ...fakeMedia, name: 'report.bin', size: 98_765 },
        mediaState: state({
            status: 'network-error',
            blobUrl: null,
            mime: null,
        }),
        onMediaRetry: noop,
    },
};

export const MediaCorrupt: Story = {
    args: {
        text: '',
        timestamp: new Date('2025-01-15T14:34:00'),
        sent: false,
        media: fakeMedia,
        mediaState: state({ status: 'corrupt', blobUrl: null, mime: null }),
        onMediaRetry: noop,
    },
};

export const MediaUnavailable: Story = {
    args: {
        text: 'missing.jpg',
        timestamp: new Date('2025-01-15T14:35:00'),
        sent: false,
        media: fakeMedia,
        mediaState: state({
            status: 'unavailable',
            blobUrl: null,
            mime: null,
        }),
        onMediaRetry: noop,
    },
};

export const MediaLoading: Story = {
    args: {
        text: 'loading.png',
        timestamp: new Date('2025-01-15T14:36:00'),
        sent: false,
        media: fakeMedia,
        mediaState: state({ status: 'loading', blobUrl: null, mime: null }),
        onMediaRetry: noop,
    },
};

// --- Amendment variants ---

export const Edited: Story = {
    args: {
        text: 'Hello Bob (fixed)',
        timestamp: new Date('2025-01-15T14:30:00'),
        sent: true,
        editedAt: new Date('2025-01-15T14:31:00'),
        onStartEdit: noop,
        onCancelEdit: noop,
        onSaveEdit: noop,
        onDelete: noop,
    },
};

export const EditedRecently: Story = {
    args: {
        text: 'typo fixed moments later',
        timestamp: new Date('2025-01-15T14:30:00'),
        sent: true,
        editedAt: new Date('2025-01-15T14:30:20'),
        onStartEdit: noop,
        onCancelEdit: noop,
        onSaveEdit: noop,
        onDelete: noop,
    },
};

// Mid tier (1h–24h): the delta becomes visible, full-opacity foreground.
export const EditedHoursLater: Story = {
    args: {
        text: 'fixed it a few hours on',
        timestamp: new Date('2025-01-15T14:30:00'),
        sent: true,
        editedAt: new Date('2025-01-15T19:30:00'),
        onStartEdit: noop,
        onCancelEdit: noop,
        onSaveEdit: noop,
        onDelete: noop,
    },
};

// Loud tier (≥ 24h): amber + medium weight so a late rewrite is conspicuous.
export const EditedLongAfter: Story = {
    args: {
        text: 'rewriting history',
        timestamp: new Date('2025-01-15T14:30:00'),
        sent: true,
        editedAt: new Date('2025-02-05T09:00:00'),
        onStartEdit: noop,
        onCancelEdit: noop,
        onSaveEdit: noop,
        onDelete: noop,
    },
};

export const Deleted: Story = {
    args: {
        text: '',
        timestamp: new Date('2025-01-15T14:30:00'),
        sent: true,
        deleted: true,
    },
};

export const EditingInline: Story = {
    args: {
        text: 'the current body, pre-filled',
        timestamp: new Date('2025-01-15T14:30:00'),
        sent: true,
        editing: true,
        onStartEdit: noop,
        onCancelEdit: noop,
        onSaveEdit: noop,
        onDelete: noop,
    },
};
