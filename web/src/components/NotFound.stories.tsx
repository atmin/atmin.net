import type { Meta, StoryObj } from '@storybook/react-vite';
import NotFound from './NotFound';

// Konsta `Page` (ADR-0023 / T5) — a bare centered 404. Flip the Konsta + theme
// toolbars for the four ios/material × light/dark combinations.
const meta = {
    title: 'App/NotFound',
    component: NotFound,
    parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof NotFound>;

export default meta;
type Story = StoryObj<typeof NotFound>;

export const Default: Story = {};
