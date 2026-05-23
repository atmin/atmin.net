import type { Meta, StoryObj } from '@storybook/react-vite';
import { OfflineIndicator } from './OfflineIndicator';

const meta = {
    title: 'App/OfflineIndicator',
    component: OfflineIndicator,
} satisfies Meta<typeof OfflineIndicator>;

export default meta;
type Story = StoryObj<typeof OfflineIndicator>;

export const Default: Story = {};
