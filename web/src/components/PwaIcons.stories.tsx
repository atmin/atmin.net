import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
    title: 'Assets/PWA Icons',
} satisfies Meta;

export default meta;
type Story = StoryObj;

const Icon = ({
    src,
    size,
    label,
}: {
    src: string;
    size: number;
    label: string;
}) => (
    <div
        style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
        }}
    >
        <img
            src={src}
            width={size}
            height={size}
            alt={label}
            style={{ border: '1px solid #e5e7eb', borderRadius: 16 }}
        />
        <span style={{ fontSize: 12, color: '#6b7280' }}>{label}</span>
    </div>
);

export const All: Story = {
    render: () => (
        <div
            style={{
                display: 'flex',
                alignItems: 'flex-end',
                gap: 32,
                padding: 32,
            }}
        >
            <Icon
                src="/icons/icon-512.png"
                size={192}
                label="512×512 — Android / maskable"
            />
            <Icon
                src="/icons/icon-192.png"
                size={96}
                label="192×192 — Android"
            />
            <Icon
                src="/icons/apple-touch-icon.png"
                size={60}
                label="180×180 — iOS"
            />
        </div>
    ),
};
