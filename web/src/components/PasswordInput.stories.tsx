import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import PasswordInput from './PasswordInput';

const meta = {
    title: 'Forms/PasswordInput',
    component: PasswordInput,
    args: {
        id: 'demo',
        onChange: fn(),
    },
    decorators: [
        (Story) => (
            <div className="max-w-md p-8">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof PasswordInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
    args: { value: '', placeholder: 'Password or recovery phrase' },
};

export const Filled: Story = {
    args: { value: 'correct-horse-battery-staple' },
};

export const Invalid: Story = {
    args: { value: 'mismatch', ariaInvalid: true },
};

export const Disabled: Story = {
    args: { value: 'correct-horse', disabled: true },
};
