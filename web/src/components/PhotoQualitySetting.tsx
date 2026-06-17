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

// Global photo-send quality preference (ADR-0022 §4). Presentational and
// controlled: the route owns the value via usePhotoQuality and persists on
// change. A per-send override is deferred to the album composer (Phase 2).
export default function PhotoQualitySetting({ value, onChange }: Props) {
    return (
        <div className="mt-8">
            <h2 className="mb-4 text-lg font-bold">Photo quality</h2>
            <div className="space-y-3" data-testid="photo-quality">
                {OPTIONS.map((opt) => {
                    const selected = value === opt.value;
                    return (
                        <button
                            key={opt.value}
                            type="button"
                            aria-pressed={selected}
                            onClick={() => onChange(opt.value)}
                            data-testid={`photo-quality-${opt.value}`}
                            className={`block w-full rounded border p-3 text-left ${
                                selected
                                    ? 'border-ring bg-muted'
                                    : 'border-input hover:bg-accent'
                            }`}
                        >
                            <span className="font-medium">{opt.label}</span>
                            {selected && (
                                <span className="ml-2 text-xs text-muted-foreground">
                                    (selected)
                                </span>
                            )}
                            <p className="text-xs text-muted-foreground">
                                {opt.hint}
                            </p>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}
