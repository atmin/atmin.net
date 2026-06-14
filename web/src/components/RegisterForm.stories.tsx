import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { HandleAvailability } from '@/hooks/useHandleAvailability';
import type { PasswordStrength } from '@/hooks/usePasswordStrength';
import RegisterForm from './RegisterForm';

const noStrength: PasswordStrength = {
    score: 0,
    feedback: [],
    pwned: false,
    loading: false,
};

const idle: HandleAvailability = { status: 'idle', message: '' };
const available: HandleAvailability = {
    status: 'available',
    message: '✓ Available.',
};
const taken: HandleAvailability = { status: 'taken', message: '✗ Taken.' };
const invalid: HandleAvailability = {
    status: 'invalid',
    message:
        'Handle must be 3–32 lowercase letters, digits, or hyphens, starting with a letter.',
};
const released: HandleAvailability = {
    status: 'released',
    message: '✗ In cooldown until 2026-06-25.',
    availableAt: '2026-06-25T00:00:00Z',
};
const checking: HandleAvailability = {
    status: 'checking',
    message: 'Checking…',
};

const meta = {
    title: 'Forms/RegisterForm',
    component: RegisterForm,
    args: {
        onHandleChange: fn(),
        onSurpriseMe: fn(),
        onPasswordChange: fn(),
        onConfirmChange: fn(),
        onAcknowledgedChange: fn(),
        onRegister: fn(),
        strength: noStrength,
        availability: idle,
        powStatus: 'ready',
        provingMs: 0,
        powHashes: 0,
    },
} satisfies Meta<typeof RegisterForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Enter: Story = {
    args: {
        step: 'enter',
        handle: '',
        password: '',
        confirm: '',
        acknowledged: false,
        error: '',
    },
};

export const HandleAvailable: Story = {
    args: {
        step: 'enter',
        handle: 'alice-test',
        password: '',
        confirm: '',
        acknowledged: false,
        error: '',
        availability: available,
    },
};

export const HandleTaken: Story = {
    args: {
        step: 'enter',
        handle: 'alice',
        password: '',
        confirm: '',
        acknowledged: false,
        error: '',
        availability: taken,
    },
};

export const HandleInvalid: Story = {
    args: {
        step: 'enter',
        handle: 'Alice',
        password: '',
        confirm: '',
        acknowledged: false,
        error: '',
        availability: invalid,
    },
};

export const HandleInCooldown: Story = {
    args: {
        step: 'enter',
        handle: 'recent-user',
        password: '',
        confirm: '',
        acknowledged: false,
        error: '',
        availability: released,
    },
};

export const HandleChecking: Story = {
    args: {
        step: 'enter',
        handle: 'alice-test',
        password: '',
        confirm: '',
        acknowledged: false,
        error: '',
        availability: checking,
    },
};

export const EnterWeak: Story = {
    args: {
        step: 'enter',
        handle: 'alice-test',
        password: 'password',
        confirm: 'password',
        acknowledged: false,
        error: '',
        availability: available,
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
        handle: 'alice-test',
        password: 'Tr0ub4dour&3xpl0re!Quokka',
        confirm: 'Tr0ub4dour&3xpl0re!Quokka',
        acknowledged: true,
        error: '',
        availability: available,
        strength: { score: 4, feedback: [], pwned: false, loading: false },
    },
};

export const Deriving: Story = {
    args: {
        step: 'deriving',
        handle: 'alice-test',
        password: 'Tr0ub4dour&3xpl0re!Quokka',
        confirm: 'Tr0ub4dour&3xpl0re!Quokka',
        acknowledged: true,
        error: '',
    },
};

export const Registering: Story = {
    args: {
        step: 'registering',
        handle: 'alice-test',
        password: '',
        confirm: '',
        acknowledged: true,
        error: '',
    },
};

export const Done: Story = {
    args: {
        step: 'done',
        handle: 'alice-test',
        password: '',
        confirm: '',
        acknowledged: true,
        error: '',
    },
};

export const WithError: Story = {
    args: {
        step: 'enter',
        handle: 'alice-test',
        password: 'Tr0ub4dour&3xpl0re!Quokka',
        confirm: 'Tr0ub4dour&3xpl0re!Quokka',
        acknowledged: true,
        error: 'That handle is already taken.',
        availability: taken,
        strength: { score: 4, feedback: [], pwned: false, loading: false },
    },
};
