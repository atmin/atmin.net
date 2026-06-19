import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { DeviceInfo } from '@/lib/api';
import DeviceSettings from './DeviceSettings';

const devices: DeviceInfo[] = [
    {
        device_id: 'dev-current',
        device_label: 'MacBook Air',
        created_at: '2026-05-01T10:00:00Z',
    },
    {
        device_id: 'dev-phone',
        device_label: 'iPhone 15',
        created_at: '2026-06-10T18:30:00Z',
    },
];

const meta = {
    title: 'Settings/DeviceSettings',
    component: DeviceSettings,
    args: {
        devices,
        currentDeviceId: 'dev-current',
        loading: false,
        error: null,
        revoking: null,
        secretInput: '',
        revokeError: null,
        onStartRevoke: fn(),
        onCancelRevoke: fn(),
        onSecretChange: fn(),
        onConfirmRevoke: fn(),
    },
} satisfies Meta<typeof DeviceSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const TwoDevices: Story = {};

export const Loading: Story = {
    args: { loading: true, devices: [] },
};

export const LoadError: Story = {
    args: { error: 'Failed to load devices.' },
};

// Revoke confirm dialog open for the non-current device.
export const RevokeDialog: Story = {
    args: { revoking: 'dev-phone' },
};

export const RevokeDialogError: Story = {
    args: {
        revoking: 'dev-phone',
        secretInput: 'wrong-pass',
        revokeError: 'Password is incorrect.',
    },
};
