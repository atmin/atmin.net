import type { Meta, StoryObj } from '@storybook/react-vite';
import Layout from './Layout';

const meta = {
    title: 'Shell/Layout',
    component: Layout,
} satisfies Meta<typeof Layout>;

export default meta;
type Story = StoryObj<typeof meta>;

const SampleTopBar = () => (
    <div className="flex w-full items-center justify-between">
        <span className="font-mono font-bold">atmin</span>
        <span className="text-xs text-muted-foreground">Settings</span>
    </div>
);

const SampleContent = () => (
    <div className="mx-auto max-w-md p-8 font-mono text-sm">
        <p className="text-muted-foreground">Page content goes here.</p>
    </div>
);

export const WithTopBar: Story = {
    args: {
        topBar: <SampleTopBar />,
        children: <SampleContent />,
    },
};

export const NoTopBar: Story = {
    args: {
        children: <SampleContent />,
    },
};

export const FullHeight: Story = {
    args: {
        fullHeight: true,
        topBar: <SampleTopBar />,
        children: (
            <>
                <div className="flex-1 overflow-y-auto p-4 font-mono text-sm">
                    <p className="text-muted-foreground">
                        Scrollable messages area
                    </p>
                </div>
                <div className="border-t border-border bg-background px-4 py-3 font-mono text-sm text-muted-foreground">
                    Docked input bar
                </div>
            </>
        ),
    },
};
