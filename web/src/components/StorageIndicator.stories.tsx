import type { Meta, StoryObj } from '@storybook/react-vite';
import { StorageIndicator } from './StorageIndicator';

const GIB = 1 << 30;
const usage = (used: number, blobCount = 12) => ({
    used_bytes: used,
    quota_bytes: GIB,
    blob_count: blobCount,
    quota_blob_cap: 1000,
});

const meta = {
    title: 'Settings/StorageIndicator',
    component: StorageIndicator,
} satisfies Meta<typeof StorageIndicator>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
    args: { loading: true, usage: null },
};

export const EmptyUsage: Story = {
    args: { loading: false, usage: usage(0, 0) },
};

export const SubMegabyte: Story = {
    args: { loading: false, usage: usage(320 * 1024, 1) },
};

export const Typical: Story = {
    args: { loading: false, usage: usage(320 * 1024 * 1024) },
};

export const Warning: Story = {
    args: { loading: false, usage: usage(Math.round(0.95 * GIB)) },
};

export const AtQuota: Story = {
    args: { loading: false, usage: usage(GIB) },
};
