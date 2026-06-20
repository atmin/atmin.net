import type { Meta, StoryObj } from '@storybook/react-vite';
import StatusCover from './StatusCover';

const meta = {
    title: 'Feedback/StatusCover',
    component: StatusCover,
    parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof StatusCover>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Deriving: Story = {
    args: { label: 'Deriving your keys…' },
};

export const Rotating: Story = {
    args: { label: 'Rotating credentials on the server…' },
};

export const Destructive: Story = {
    args: { label: 'Deleting your account…', destructive: true },
};
