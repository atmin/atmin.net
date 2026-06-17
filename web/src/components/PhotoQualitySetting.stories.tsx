import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import type { PhotoQuality } from '@/lib/photo-quality';
import PhotoQualitySetting from './PhotoQualitySetting';

const meta = {
    title: 'Settings/PhotoQualitySetting',
    component: PhotoQualitySetting,
} satisfies Meta<typeof PhotoQualitySetting>;

export default meta;
type Story = StoryObj<typeof meta>;

// Interactive: clicking an option moves the selection so both states (and the
// hover/selected styling in light + dark) are exercisable from one story.
function Interactive({ initial }: { initial: PhotoQuality }) {
    const [value, setValue] = useState<PhotoQuality>(initial);
    return <PhotoQualitySetting value={value} onChange={setValue} />;
}

// `args` is required by the inferred type (both props are required); the
// interactive render ignores them and drives selection through local state.
const noopArgs = { value: 'optimized', onChange: () => {} } as const;

export const Optimized: Story = {
    args: noopArgs,
    render: () => <Interactive initial="optimized" />,
};

export const Original: Story = {
    args: noopArgs,
    render: () => <Interactive initial="original" />,
};
