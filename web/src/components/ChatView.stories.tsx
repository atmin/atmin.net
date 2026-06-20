import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import ChatView from './ChatView';

const meta = {
    title: 'Chat/ChatView',
    component: ChatView,
    parameters: { layout: 'fullscreen' },
    args: {
        onSend: fn(),
        onBack: fn(),
        encryptionReady: true,
        online: true,
        inputValue: '',
        setInputValue: fn(),
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

// A restored draft: the input is pre-filled (e.g. after a refresh).
export const Draft: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [],
        loading: false,
        sending: false,
        inputValue: 'half-typed message…',
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

export const WithScrolledUpIndicator: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'Older message',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: false,
            },
            {
                id: '2',
                text: 'Newer message — user has scrolled up so a jump indicator is visible',
                timestamp: new Date('2024-01-15T10:31:00Z'),
                sent: false,
            },
        ],
        loading: false,
        sending: false,
        showJumpToBottom: true,
        onJumpToBottom: fn(),
    },
};

export const Offline: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'This was synced before the network dropped.',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: false,
            },
        ],
        loading: false,
        sending: false,
        online: false,
    },
};

export const WithAmendments: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'Hello Bob (edited)',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: true,
                editedAt: new Date('2024-01-15T10:31:00Z'),
            },
            {
                id: '2',
                text: '',
                timestamp: new Date('2024-01-15T10:32:00Z'),
                sent: true,
                deleted: true,
            },
            {
                id: '3',
                text: 'A normal received message',
                timestamp: new Date('2024-01-15T10:33:00Z'),
                sent: false,
            },
        ],
        loading: false,
        sending: false,
        onEditMessage: fn(),
        onDeleteMessage: fn(),
    },
};

// ── Compose tray (P1d, ADR-0022) ────────────────────────────────────────────
// A solid-fill SVG data URI stands in for a real object-URL thumbnail (stories
// can't mint blob: URLs statically); it reads in both light and dark.
const SAMPLE_THUMB =
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Crect width='160' height='160' fill='%2360a5fa'/%3E%3C/svg%3E";

// Shared args turning on the compose affordances (📎 + staging callbacks).
const composeArgs = {
    chatTitle: 'copper-falcon',
    isSaved: false,
    handle: 'copper-falcon',
    messages: [],
    loading: false,
    sending: false,
    onSendMedia: fn(),
    onAttach: fn(),
    onClearAttachment: fn(),
};

// Empty compose row with the attach control available — nothing staged yet.
export const ComposeEmpty: Story = {
    args: { ...composeArgs },
};

// Text typed, no attachment — Send dispatches a plain text message (today's path).
export const ComposeTextOnly: Story = {
    args: { ...composeArgs, inputValue: 'just a normal message' },
};

// A staged image: the tray shows its thumbnail with a remove (✕); Send is
// enabled even with no caption (a caption-less image is a valid send).
export const ComposeStagedImage: Story = {
    args: {
        ...composeArgs,
        pending: {
            file: new File(['x'], 'beach.jpg', { type: 'image/jpeg' }),
            previewUrl: SAMPLE_THUMB,
            isImage: true,
        },
    },
};

// Staged image plus a typed caption — Send produces one media message whose
// body is the caption.
export const ComposeStagedImageWithCaption: Story = {
    args: {
        ...composeArgs,
        inputValue: 'sunset, night one',
        pending: {
            file: new File(['x'], 'beach.jpg', { type: 'image/jpeg' }),
            previewUrl: SAMPLE_THUMB,
            isImage: true,
        },
    },
};

// A staged non-image renders as a name + size chip (no thumbnail).
export const ComposeStagedFile: Story = {
    args: {
        ...composeArgs,
        pending: {
            file: new File([new Uint8Array(204_800)], 'report.pdf', {
                type: 'application/pdf',
            }),
            previewUrl: '',
            isImage: false,
        },
    },
};

// Confirms the "only one message edits at a time" invariant: bubble 2 is in
// inline-edit mode (Save/Cancel visible) while the others render normally.
export const WithOneMessageEditing: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'First message',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: true,
            },
            {
                id: '2',
                text: 'This one is being edited',
                timestamp: new Date('2024-01-15T10:31:00Z'),
                sent: true,
            },
            {
                id: '3',
                text: 'Third message',
                timestamp: new Date('2024-01-15T10:32:00Z'),
                sent: true,
            },
        ],
        loading: false,
        sending: false,
        onEditMessage: fn(),
        onDeleteMessage: fn(),
    },
    play: async ({ canvas, userEvent }) => {
        // Open message 2's action menu and click Edit.
        const triggers = canvas.getAllByTestId('message-actions-trigger');
        await userEvent.click(triggers[1]);
        await userEvent.click(canvas.getByTestId('message-action-edit'));
    },
};
