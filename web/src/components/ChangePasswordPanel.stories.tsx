import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { PasswordStrength } from '@/hooks/usePasswordStrength';
import ChangePasswordPanel from './ChangePasswordPanel';

const noStrength: PasswordStrength = {
    score: 0,
    feedback: [],
    pwned: false,
    loading: false,
};

const strong: PasswordStrength = {
    score: 4,
    feedback: [],
    pwned: false,
    loading: false,
};

const meta = {
    title: 'Forms/ChangePasswordPanel',
    component: ChangePasswordPanel,
    args: {
        onCurrentChange: fn(),
        onNewChange: fn(),
        onConfirmChange: fn(),
        onAcknowledgedChange: fn(),
        onSubmit: fn(),
        strength: noStrength,
    },
    // The form/step content now lives in a Konsta Sheet; open it on render so
    // every story shows its state (matches DeleteAccountPanel's pattern).
    play: async ({ canvas, userEvent }) => {
        await userEvent.click(canvas.getByTestId('change-password-trigger'));
    },
} satisfies Meta<typeof ChangePasswordPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Enter: Story = {
    args: {
        step: 'enter',
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
        acknowledged: false,
        error: null,
    },
};

export const EnterFilled: Story = {
    args: {
        step: 'enter',
        currentPassword: 'old-pass',
        newPassword: 'new-pass-strong',
        confirmPassword: 'new-pass-strong',
        acknowledged: true,
        error: null,
        strength: strong,
    },
};

export const EnterMismatch: Story = {
    args: {
        step: 'enter',
        currentPassword: 'old-pass',
        newPassword: 'new-pass-strong',
        confirmPassword: 'new-pass-strongER',
        acknowledged: true,
        error: null,
        strength: strong,
    },
};

export const EnterWithError: Story = {
    args: {
        step: 'enter',
        currentPassword: 'old-pass',
        newPassword: 'new-pass',
        confirmPassword: 'new-pass',
        acknowledged: true,
        error: 'Current password is incorrect.',
    },
};

export const DerivingOld: Story = {
    args: {
        step: 'deriving-old',
        currentPassword: 'old-pass',
        newPassword: 'new-pass',
        confirmPassword: 'new-pass',
        acknowledged: true,
        error: null,
    },
};

export const DerivingNew: Story = {
    args: {
        step: 'deriving-new',
        currentPassword: 'old-pass',
        newPassword: 'new-pass',
        confirmPassword: 'new-pass',
        acknowledged: true,
        error: null,
    },
};

export const WritingChain: Story = {
    args: {
        step: 'writing-chain',
        currentPassword: 'old-pass',
        newPassword: 'new-pass',
        confirmPassword: 'new-pass',
        acknowledged: true,
        error: null,
    },
};

export const Rotating: Story = {
    args: {
        step: 'rotating',
        currentPassword: 'old-pass',
        newPassword: 'new-pass',
        confirmPassword: 'new-pass',
        acknowledged: true,
        error: null,
    },
};

export const Done: Story = {
    args: {
        step: 'done',
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
        acknowledged: false,
        error: null,
    },
};
