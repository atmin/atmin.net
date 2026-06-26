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

// The "New" divider (ADR-0026): a full-width rule above the first incoming
// message newer than the read watermark captured on open. Here the boundary
// sits between the reply (10:31) and the two messages that arrived since, so
// the divider renders above the first of those. Own sends never trigger it.
export const WithNewDivider: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        newBoundary: new Date('2024-01-15T10:31:30Z').getTime(),
        messages: [
            {
                id: '1',
                text: 'A message you already saw',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: false,
            },
            {
                id: '2',
                text: 'Your reply',
                timestamp: new Date('2024-01-15T10:31:00Z'),
                sent: true,
            },
            {
                id: '3',
                text: 'This arrived since you last looked',
                timestamp: new Date('2024-01-15T10:32:00Z'),
                sent: false,
            },
            {
                id: '4',
                text: 'And so did this one',
                timestamp: new Date('2024-01-15T10:33:00Z'),
                sent: false,
            },
        ],
        loading: false,
        sending: false,
    },
};

// Day-dividers across a multi-day timeline. Timestamps are anchored relative to
// render time so the labels always read Today / Yesterday / an older date no
// matter when the story is opened (the divider label is viewer-local + relative
// to now). Verifies the "<date>" / "Yesterday" / "Today" buckets in one frame
// and in both ios/material × light/dark. Each divider is a centered pill with
// vertical margin; at runtime it pins to the top of the scroll container
// (`sticky`), so the current day stays in view — exercise the pinning by
// scrolling a taller timeline in the app, not here.
const DAY = 86_400_000;
const at = (daysAgo: number, hh: number, mm: number) => {
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hh, mm, 0, 0);
    return d;
};
export const WithDaySeparators: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'Way back when we first set this up.',
                timestamp: new Date(Date.now() - 400 * DAY), // earlier year
                sent: false,
            },
            {
                id: '2',
                text: 'A note from a few days ago.',
                timestamp: at(4, 9, 15), // this year, dated label
                sent: true,
            },
            {
                id: '3',
                text: 'Did you see the deploy went out?',
                timestamp: at(1, 18, 30), // yesterday
                sent: false,
            },
            {
                id: '4',
                text: 'Yep — green across the board.',
                timestamp: at(1, 18, 32), // still yesterday, no new divider
                sent: true,
            },
            {
                id: '5',
                text: 'Morning! Starting on the revamp today.',
                timestamp: at(0, 8, 5), // today
                sent: false,
            },
            {
                id: '6',
                text: 'The date dividers look great.',
                timestamp: at(0, 8, 10), // still today, no new divider
                sent: true,
            },
        ],
        loading: false,
        sending: false,
    },
};

// A received message with newlines — the bubble must preserve them (whitespace-
// pre-wrap), now that the composer can produce multi-line sends.
export const WithMultilineMessage: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'Shopping list:\n- milk\n- eggs\n- a very long line that should wrap onto the next visual row on its own without breaking the others',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: false,
            },
        ],
        loading: false,
        sending: false,
    },
};

// Regression: a long unbreakable token (server-log line) must wrap inside the
// bubble (wrap-anywhere) rather than widen the column into a horizontal
// scrollbar. A narrow sent bubble alongside shares the same small right margin.
// onDeleteMessage makes these own bubbles amendable, so the ⋮ trigger shows.
export const WideUnbreakableMessage: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'ok',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: true,
            },
            {
                id: '2',
                text: 'level=info msg=request request_id=01KVJKJQGEF90SE5PVF11AX33S method=GET path=/v1/store/object status=200 dur_ms=3 ip=127.0.0.1 user_id=01KVJJAH971RXNVEMHJ11F69BF',
                timestamp: new Date('2024-01-15T10:31:00Z'),
                sent: true,
            },
        ],
        loading: false,
        sending: false,
        onStartEdit: fn(),
        onDeleteMessage: fn(),
    },
};

// A sent image attachment in its idle (not-yet-fetched) state: the reserved
// aspect-ratio placeholder must fit inside the bubble, not overflow it; the ⋮
// trigger sits in the lower-right, clear of the image (T4b fine-tuning).
export const WithImageAttachment: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'check this out',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: true,
                media: {
                    url: 'media/01STORY/wide',
                    key: new Uint8Array(32),
                    iv: new Uint8Array(12),
                    name: 'wide.jpg',
                    size: 482_113,
                    width: 2048,
                    height: 1536,
                },
            },
        ],
        loading: false,
        sending: false,
        mediaStates: {
            'media/01STORY/wide': {
                status: 'idle',
                blobUrl: null,
                mime: null,
            },
        },
        onMediaRequest: fn(),
        onStartEdit: fn(),
        onDeleteMessage: fn(),
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
        onStartEdit: fn(),
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

// A multi-line draft. Konsta fixes the textarea height; useAutogrowTextarea (wired
// in the route) grows it. Storybook renders the component without the route, so the
// textarea shows clipped here — the grow behavior is exercised against this story in
// the screenshot harness / at runtime.
export const ComposeMultiline: Story = {
    args: {
        ...composeArgs,
        inputValue: 'first line\nsecond line\nthird line',
    },
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

// Editing reuses the composer: bubble 2's body is loaded into the Messagebar and
// the "Editing message" banner is shown (Send becomes a Save check). The bubbles
// render normally — there is no longer an inline editor.
export const EditingInComposer: Story = {
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
        editingId: '2',
        editValue: 'This one is being edited',
        onStartEdit: fn(),
        onEditValueChange: fn(),
        onCancelEdit: fn(),
        onCommitEdit: fn(),
        onDeleteMessage: fn(),
    },
};

// The per-bubble action sheet, opened over the timeline. Verifies the Konsta
// Actions overlay escapes its transform-ed bubble and fills the viewport rather
// than clipping to a single bubble's box (T4b).
export const WithActionSheet: Story = {
    args: {
        chatTitle: 'copper-falcon',
        isSaved: false,
        handle: 'copper-falcon',
        messages: [
            {
                id: '1',
                text: 'Tap the ⋯ to edit or delete me',
                timestamp: new Date('2024-01-15T10:30:00Z'),
                sent: true,
            },
        ],
        loading: false,
        sending: false,
        onStartEdit: fn(),
        onDeleteMessage: fn(),
    },
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByTestId('message-actions-trigger'));
    },
};
