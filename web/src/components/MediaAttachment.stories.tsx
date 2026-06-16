import type { Meta, StoryObj } from '@storybook/react-vite';
import type { MediaState } from '@/hooks/useMedia';
import MediaAttachment from './MediaAttachment';

const meta = {
    title: 'Chat/MediaAttachment',
    component: MediaAttachment,
    args: {
        onRequest: () => {},
    },
} satisfies Meta<typeof MediaAttachment>;

export default meta;
type Story = StoryObj<typeof meta>;

// A small teal PNG so the "ready image" story renders a real bitmap.
const PNG_DATA_URL =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAZElEQVR4nO3PwQkAIBDAsBvC/fHtlA7hIwiFDpDO2ufrhgsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS1oQAsa0IIGtKABLWhACxrQgga0oAEtaEALGtCCBrSgAS147AJBjGjx+mPC+wAAAABJRU5ErkJggg==';

const state = (s: MediaState): MediaState => s;

// Image, not yet requested: the observable placeholder box.
export const IdlePlaceholder: Story = {
    args: {
        name: 'sunset.jpg',
        size: 482_113,
        state: state({ status: 'idle', blobUrl: null, mime: null }),
    },
};

export const Loading: Story = {
    args: {
        name: 'sunset.jpg',
        size: 482_113,
        state: state({ status: 'loading', blobUrl: null, mime: null }),
    },
};

export const ReadyImage: Story = {
    args: {
        name: 'sunset.png',
        size: 482_113,
        state: state({
            status: 'ready',
            blobUrl: PNG_DATA_URL,
            mime: 'image/png',
        }),
    },
};

// Non-image, after click-to-fetch resolves: a download link.
export const ReadyDownload: Story = {
    args: {
        name: 'quarterly-report.pdf',
        size: 1_284_577,
        state: state({
            status: 'ready',
            blobUrl: PNG_DATA_URL,
            mime: null,
        }),
    },
};

export const Corrupt: Story = {
    args: {
        name: 'sunset.jpg',
        size: 482_113,
        state: state({ status: 'corrupt', blobUrl: null, mime: null }),
    },
};

export const Unavailable: Story = {
    args: {
        name: 'sunset.jpg',
        size: 482_113,
        state: state({ status: 'unavailable', blobUrl: null, mime: null }),
    },
};

export const NetworkError: Story = {
    args: {
        name: 'sunset.jpg',
        size: 482_113,
        state: state({
            status: 'network-error',
            blobUrl: null,
            mime: null,
        }),
    },
};

// Non-image, never auto-fetched: the metadata-only chip (no `state`). Clicking
// it triggers the on-demand fetch.
export const NonImageChip: Story = {
    args: {
        name: 'quarterly-report.pdf',
        size: 1_284_577,
        state: undefined,
    },
};
