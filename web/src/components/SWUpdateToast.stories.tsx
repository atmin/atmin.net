import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { SWUpdateToast } from './SWUpdateToast';

const meta = {
    title: 'App/SWUpdateToast',
    component: SWUpdateToast,
    args: {
        onUpdate: fn(),
        onDismiss: fn(),
    },
} satisfies Meta<typeof SWUpdateToast>;

export default meta;
type Story = StoryObj<typeof SWUpdateToast>;

export const UpdateAvailable: Story = {
    args: { sending: false },
};

export const UpdateWhileSending: Story = {
    args: { sending: true },
};
