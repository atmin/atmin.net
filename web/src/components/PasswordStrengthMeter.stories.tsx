import type { Meta, StoryObj } from '@storybook/react-vite';
import PasswordStrengthMeter from './PasswordStrengthMeter';

const meta = {
    title: 'Forms/PasswordStrengthMeter',
    component: PasswordStrengthMeter,
    decorators: [
        (Story) => (
            <div className="max-w-md p-8">
                <Story />
            </div>
        ),
    ],
} satisfies Meta<typeof PasswordStrengthMeter>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Score0: Story = {
    args: { score: 0, feedback: ['Add another word or two.'] },
};

export const Score1: Story = {
    args: { score: 1 },
};

export const Score2: Story = {
    args: { score: 2 },
};

export const Score3: Story = {
    args: { score: 3 },
};

export const Score4: Story = {
    args: { score: 4 },
};

export const Pwned: Story = {
    args: { score: 1, pwned: true },
};

export const Loading: Story = {
    args: { score: 0, loading: true },
};
