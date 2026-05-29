import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import LoginForm from './LoginForm';

const meta = {
    title: 'Forms/LoginForm',
    component: LoginForm,
    args: {
        onLogin: fn(),
    },
} satisfies Meta<typeof LoginForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
    args: {
        loading: false,
        error: '',
    },
};

export const Loading: Story = {
    args: {
        loading: true,
        error: '',
    },
};

export const WithError: Story = {
    args: {
        loading: false,
        error: 'Incorrect password. Please try again.',
    },
};

export const RotatedElsewhere: Story = {
    args: {
        loading: false,
        error: '',
        notice: 'rotated_elsewhere',
        onDismissNotice: fn(),
    },
};
