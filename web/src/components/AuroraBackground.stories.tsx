import type { Meta, StoryObj } from '@storybook/react-vite';
import AuroraBackground from './ui/AuroraBackground';

const meta = {
    title: 'Components/AuroraBackground',
    component: AuroraBackground,
    parameters: {
        layout: 'fullscreen',
        docs: {
            description: {
                component:
                    'Scroll (or wheel over the canvas) to animate the blobs.',
            },
        },
    },
    argTypes: {
        bgColor: { control: 'color' },
        blob1Color: { control: 'color' },
        blob2Color: { control: 'color' },
        blobRadius: {
            control: { type: 'range', min: 0.05, max: 1.5, step: 0.01 },
        },
        blobRadiusSecondary: {
            control: { type: 'range', min: 0.05, max: 1.5, step: 0.01 },
        },
        blobStrength: {
            control: { type: 'range', min: 0, max: 1, step: 0.01 },
        },
        noiseStrength: {
            control: { type: 'range', min: 0, max: 0.2, step: 0.005 },
        },
        scrollScale: {
            control: { type: 'range', min: 100, max: 3000, step: 50 },
        },
        velocityStrength: {
            control: { type: 'range', min: 0, max: 0.2, step: 0.005 },
        },
        velocityDecay: {
            control: { type: 'range', min: 0.5, max: 0.99, step: 0.01 },
        },
    },
} satisfies Meta<typeof AuroraBackground>;

export default meta;
type Story = StoryObj<typeof meta>;

const items = Array.from({ length: 1000 }, (_, i) => i + 1);

const scrollableContent = (color: string) => (
    <ul
        style={{
            position: 'relative',
            zIndex: 1,
            margin: 0,
            padding: '16px 24px',
            listStyle: 'none',
            fontFamily: 'monospace',
            fontSize: 13,
            color,
        }}
    >
        {items.map((n) => (
            <li key={n} style={{ padding: '4px 0', opacity: 0.5 }}>
                item {n}
            </li>
        ))}
    </ul>
);

export const Dark: Story = {
    args: {
        bgColor: '#1a1a2e',
        blob1Color: '#e94560',
        blob2Color: '#0f3460',
        blobRadius: 0.6,
        blobRadiusSecondary: 0.6,
        blobStrength: 0.5,
        noiseStrength: 0.06,
        scrollScale: 800,
        velocityStrength: 0.03,
        velocityDecay: 0.94,
    },
    render: (args) => (
        <AuroraBackground {...args}>
            {scrollableContent('rgba(255,255,255,0.9)')}
        </AuroraBackground>
    ),
};

export const Light: Story = {
    args: {
        bgColor: '#f0ede8',
        blob1Color: '#c0392b',
        blob2Color: '#2471a3',
        blobRadius: 0.6,
        blobRadiusSecondary: 0.6,
        blobStrength: 0.5,
        noiseStrength: 0.06,
        scrollScale: 800,
        velocityStrength: 0.03,
        velocityDecay: 0.94,
    },
    render: (args) => (
        <AuroraBackground {...args}>
            {scrollableContent('rgba(0,0,0,0.75)')}
        </AuroraBackground>
    ),
};

export const CoolMist: Story = {
    args: {
        bgColor: '#0d1117',
        blob1Color: '#58a6ff',
        blob2Color: '#3fb950',
        blobRadius: 0.6,
        blobRadiusSecondary: 0.6,
        blobStrength: 0.5,
        noiseStrength: 0.06,
        scrollScale: 600,
        velocityStrength: 0.03,
        velocityDecay: 0.94,
    },
    render: (args) => (
        <AuroraBackground {...args}>
            {scrollableContent('rgba(255,255,255,0.9)')}
        </AuroraBackground>
    ),
};
