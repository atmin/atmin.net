import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import PasswordField from './PasswordField';

const meta = {
    title: 'Forms/PasswordField',
    component: PasswordField,
    args: {
        onPasswordChange: fn(),
        onConfirmChange: fn(),
    },
    decorators: [
        (Story) => (
            <div className="max-w-md p-8">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof PasswordField>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
    args: { password: '', confirm: '' },
};

export const Typing: Story = {
    args: { password: 'correct-horse', confirm: '' },
};

export const ConfirmMismatch: Story = {
    args: { password: 'correct-horse', confirm: 'correct-hoarse' },
};

export const Matching: Story = {
    args: { password: 'correct-horse', confirm: 'correct-horse' },
};

export const Disabled: Story = {
    args: {
        password: 'correct-horse',
        confirm: 'correct-horse',
        disabled: true,
    },
};
