import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { RestoreWarningToast } from './RestoreWarningToast';

const meta = {
    title: 'App/RestoreWarningToast',
    component: RestoreWarningToast,
    args: {
        onDismiss: fn(),
    },
} satisfies Meta<typeof RestoreWarningToast>;

export default meta;
type Story = StoryObj<typeof RestoreWarningToast>;

export const One: Story = {
    args: { count: 1 },
};

export const Several: Story = {
    args: { count: 4 },
};
