import type { Meta, StoryObj } from '@storybook/react-vite';
import { Block, BlockTitle, Button } from 'konsta/react';

// ADR-0023 T0 — harness smoke test, not a real app component. Verifies a trivial
// Konsta component renders correctly under the .storybook decorator in all four
// combinations: switch the "Konsta" toolbar (iOS / Material) against the theme
// toolbar (light / dark). Filled/tonal/outline/clear make the platform styling
// (corner radius, ripple, weight) obvious. Delete in T6 once real Konsta screens
// carry their own stories.
const meta = {
    title: 'Konsta/Harness Check',
    component: Button,
    parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Buttons: Story = {
    render: () => (
        <>
            <BlockTitle>Buttons</BlockTitle>
            <Block strong className="space-y-4">
                <Button>Filled</Button>
                <Button tonal>Tonal</Button>
                <Button outline>Outline</Button>
                <Button clear>Clear</Button>
                <Button rounded>Rounded</Button>
                <Button disabled>Disabled</Button>
            </Block>
        </>
    ),
};
