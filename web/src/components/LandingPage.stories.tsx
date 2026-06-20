import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import LandingPage from './LandingPage';

const meta = {
    title: 'Pages/Landing',
    component: LandingPage,
    parameters: { layout: 'fullscreen' },
    args: { onDismiss: fn() },
} satisfies Meta<typeof LandingPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const AccountDeleted: Story = {
    args: { accountDeleted: true },
};
