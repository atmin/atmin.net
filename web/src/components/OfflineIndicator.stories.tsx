import type { Meta, StoryObj } from '@storybook/react-vite';
import { OfflineIndicator } from './OfflineIndicator';

// Konsta `Toast` (ADR-0023 / T5) — a frosted bottom status pill. Flip the
// Konsta (iOS/Material) and theme (light/dark) toolbars to verify all four
// combinations; the toast is `fixed` so it anchors to the canvas bottom edge.
const meta = {
    title: 'App/OfflineIndicator',
    component: OfflineIndicator,
    parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof OfflineIndicator>;

export default meta;
type Story = StoryObj<typeof OfflineIndicator>;

export const Default: Story = {};
