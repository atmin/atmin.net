import type { Meta, StoryObj } from '@storybook/react-vite';
import ProfileSettings from './ProfileSettings';

const meta = {
    title: 'Settings/ProfileSettings',
    component: ProfileSettings,
} satisfies Meta<typeof ProfileSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
    args: {
        handle: 'copper-falcon',
        token: 'fake-token',
    },
};

export const WithDisplayName: Story = {
    args: {
        handle: 'copper-falcon',
        token: 'fake-token',
        initialDisplayName: 'Alice Wonderland',
    },
};
