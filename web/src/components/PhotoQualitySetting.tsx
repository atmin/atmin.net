import { BlockTitle, List, ListItem } from 'konsta/react';
import { Check } from 'lucide-react';
import type { PhotoQuality } from '@/lib/photo-quality';

interface Props {
    value: PhotoQuality;
    onChange: (quality: PhotoQuality) => void;
}

const OPTIONS: { value: PhotoQuality; label: string; hint: string }[] = [
    {
        value: 'optimized',
        label: 'Optimized',
        hint: 'Smaller and faster to send; metadata (e.g. location) is removed. Recommended.',
    },
    {
        value: 'original',
        label: 'Original quality',
        hint: 'Sends the untouched file — includes its metadata.',
    },
];

// Global photo-send quality preference (ADR-0022 §4). Single-select grouped list
// with a checkmark on the active row; the hint stays as sub-text so the guidance
// survives (a bare Toggle would drop it). Controlled — the route owns the value.
export default function PhotoQualitySetting({ value, onChange }: Props) {
    return (
        <>
            <BlockTitle>Photo quality</BlockTitle>
            <List strong inset data-testid="photo-quality">
                {OPTIONS.map((opt) => {
                    const selected = value === opt.value;
                    return (
                        <ListItem
                            key={opt.value}
                            link
                            chevron={false}
                            title={opt.label}
                            text={opt.hint}
                            after={
                                selected ? (
                                    <Check className="h-5 w-5 text-primary" />
                                ) : undefined
                            }
                            onClick={() => onChange(opt.value)}
                            data-testid={`photo-quality-${opt.value}`}
                        />
                    );
                })}
            </List>
        </>
    );
}
