import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { PasswordStrength } from '@/hooks/usePasswordStrength';
import RegisterForm from './RegisterForm';

const noStrength: PasswordStrength = {
    score: 0,
    feedback: [],
    pwned: false,
    loading: false,
};

const meta = {
    title: 'Forms/RegisterForm',
    component: RegisterForm,
    args: {
        onPasswordChange: fn(),
        onConfirmChange: fn(),
        onAcknowledgedChange: fn(),
        onRegister: fn(),
        strength: noStrength,
    },
} satisfies Meta<typeof RegisterForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Enter: Story = {
    args: {
        step: 'enter',
        password: '',
        confirm: '',
        acknowledged: false,
        error: '',
    },
};

export const EnterWeak: Story = {
    args: {
        step: 'enter',
        password: 'password',
        confirm: 'password',
        acknowledged: false,
        error: '',
        strength: {
            score: 0,
            feedback: ['This is a top-10 common password.'],
            pwned: true,
            loading: false,
        },
    },
};

export const EnterStrong: Story = {
    args: {
        step: 'enter',
        password: 'Tr0ub4dour&3xpl0re!Quokka',
        confirm: 'Tr0ub4dour&3xpl0re!Quokka',
        acknowledged: true,
        error: '',
        strength: { score: 4, feedback: [], pwned: false, loading: false },
    },
};

export const Deriving: Story = {
    args: {
        step: 'deriving',
        password: 'Tr0ub4dour&3xpl0re!Quokka',
        confirm: 'Tr0ub4dour&3xpl0re!Quokka',
        acknowledged: true,
        error: '',
    },
};

export const Registering: Story = {
    args: {
        step: 'registering',
        password: '',
        confirm: '',
        acknowledged: true,
        error: '',
    },
};

export const Done: Story = {
    args: {
        step: 'done',
        password: '',
        confirm: '',
        acknowledged: true,
        error: '',
    },
};

export const WithError: Story = {
    args: {
        step: 'enter',
        password: 'Tr0ub4dour&3xpl0re!Quokka',
        confirm: 'Tr0ub4dour&3xpl0re!Quokka',
        acknowledged: true,
        error: 'Registration failed: network error',
        strength: { score: 4, feedback: [], pwned: false, loading: false },
    },
};
