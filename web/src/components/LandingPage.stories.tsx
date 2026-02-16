import type { Meta, StoryObj } from '@storybook/react-vite';
import LandingPage from './LandingPage';

const meta = {
    title: 'Pages/Landing',
    component: LandingPage,
} satisfies Meta<typeof LandingPage>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
