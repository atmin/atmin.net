import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { RestoreWarningToast } from './RestoreWarningToast';

// Konsta `Toast` (ADR-0023 / T5) — a frosted warning pill with an amber alert
// icon and a Dismiss action. Flip the Konsta + theme toolbars for the four
// ios/material × light/dark combinations.
const meta = {
    title: 'App/RestoreWarningToast',
    component: RestoreWarningToast,
    parameters: { layout: 'fullscreen' },
    args: {
        onDismiss: fn(),
    },
} satisfies Meta<typeof RestoreWarningToast>;

export default meta;
type Story = StoryObj<typeof RestoreWarningToast>;

export const One: Story = {
    args: { count: 1 },
};

export const Several: Story = {
    args: { count: 4 },
};
