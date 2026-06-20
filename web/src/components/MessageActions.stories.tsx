import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import MessageActions from './MessageActions';

const meta = {
    title: 'Chat/MessageActions',
    component: MessageActions,
    // The sheet is a fixed-position overlay — give it the whole viewport.
    parameters: { layout: 'fullscreen' },
    args: {
        opened: true,
        canEdit: true,
        onEdit: fn(),
        onDelete: fn(),
        onClose: fn(),
    },
} satisfies Meta<typeof MessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;

// Editable message (text or media-with-caption): both Edit and Delete.
export const Editable: Story = {};

// Pure-media message: Delete only (Edit is hidden).
export const DeleteOnly: Story = {
    args: { canEdit: false },
};

// The two-step delete confirm (after picking Delete).
export const ConfirmingDelete: Story = {
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByTestId('message-action-delete'));
    },
};
