import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import MessageActions from './MessageActions';

const meta = {
    title: 'Chat/MessageActions',
    component: MessageActions,
    args: {
        onEdit: fn(),
        onDelete: fn(),
    },
    // The trigger is opacity-0 until hover; render it inside a group container
    // so the menu is visible in the story.
    decorators: [
        (Story) => (
            <div className="group relative h-40 w-48 rounded bg-bubble-sent">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof MessageActions>;

export default meta;
type Story = StoryObj<typeof meta>;

// Editable message (text or media-with-caption): both Edit and Delete.
export const Editable: Story = {};

// Pure-media message: Delete only (Edit is hidden).
export const DeleteOnly: Story = {
    args: {
        onEdit: undefined,
    },
};

// The two-step delete confirm prompt (after picking Delete).
export const ConfirmingDelete: Story = {
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByTestId('message-actions-trigger'));
        await userEvent.click(canvas.getByTestId('message-action-delete'));
    },
};
