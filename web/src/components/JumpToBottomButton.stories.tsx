import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { JumpToBottomButton } from './JumpToBottomButton';

const meta = {
    title: 'Chat/JumpToBottomButton',
    component: JumpToBottomButton,
    decorators: [
        (Story) => (
            <div className="relative h-64 w-full max-w-md rounded border border-dashed border-border bg-muted/30">
                <Story />
            </div>
        ),
    ],
    args: {
        onClick: fn(),
    },
} satisfies Meta<typeof JumpToBottomButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
