import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { SWUpdateToast } from './SWUpdateToast';

// Konsta `Toast` (ADR-0023 / T5) with a Reload action + dismiss in its button
// slot. Flip the Konsta + theme toolbars for the four ios/material × light/dark
// combinations.
const meta = {
    title: 'App/SWUpdateToast',
    component: SWUpdateToast,
    parameters: { layout: 'fullscreen' },
    args: {
        onUpdate: fn(),
        onDismiss: fn(),
    },
} satisfies Meta<typeof SWUpdateToast>;

export default meta;
type Story = StoryObj<typeof SWUpdateToast>;

export const UpdateAvailable: Story = {
    args: { sending: false },
};

// While a message send is in flight the Reload action is disabled (a refresh
// would drop the in-flight send) — it reads "Sending…".
export const UpdateWhileSending: Story = {
    args: { sending: true },
};
