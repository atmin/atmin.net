import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import RegisterForm from './RegisterForm';

const meta = {
    title: 'Forms/RegisterForm',
    component: RegisterForm,
    args: {
        onRegister: fn(),
    },
} satisfies Meta<typeof RegisterForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Generate: Story = {
    args: {
        step: 'generate',
        mnemonic:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        error: '',
    },
};

export const GenerateWithError: Story = {
    args: {
        step: 'generate',
        mnemonic:
            'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
        error: 'Registration failed: network error',
    },
};

export const Registering: Story = {
    args: {
        step: 'registering',
        mnemonic: '',
        error: '',
    },
};

export const Done: Story = {
    args: {
        step: 'done',
        mnemonic: '',
        error: '',
    },
};
