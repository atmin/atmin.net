import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import DeleteAccountPanel from './DeleteAccountPanel';

const meta = {
    title: 'Settings/DeleteAccountPanel',
    component: DeleteAccountPanel,
    args: {
        handle: 'copper-falcon',
        step: 'enter',
        password: '',
        handleConfirm: '',
        acknowledged: false,
        error: null,
        onPasswordChange: fn(),
        onHandleConfirmChange: fn(),
        onAcknowledgedChange: fn(),
        onSubmit: fn(),
    },
} satisfies Meta<typeof DeleteAccountPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// Collapsed Danger-zone footer (the default resting state).
export const Collapsed: Story = {};

// Expanded with the confirmation form, blank — open the panel via the play fn.
export const ExpandedBlank: Story = {
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByTestId('delete-account-trigger'));
    },
};

// Expanded with everything filled in (submit enabled).
export const ExpandedFilled: Story = {
    args: {
        password: 'hunter2hunter2',
        handleConfirm: 'copper-falcon',
        acknowledged: true,
    },
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByTestId('delete-account-trigger'));
    },
};

export const WrongPasswordError: Story = {
    args: {
        password: 'nope',
        handleConfirm: 'copper-falcon',
        acknowledged: true,
        error: 'Password is incorrect.',
    },
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByTestId('delete-account-trigger'));
    },
};

export const Verifying: Story = {
    args: { step: 'verifying' },
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByTestId('delete-account-trigger'));
    },
};

export const Deleting: Story = {
    args: { step: 'deleting' },
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByTestId('delete-account-trigger'));
    },
};
