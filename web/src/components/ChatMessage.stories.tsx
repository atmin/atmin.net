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
