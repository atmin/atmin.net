interface Props {
    score: 0 | 1 | 2 | 3 | 4;
    feedback?: string[];
    pwned?: boolean;
    loading?: boolean;
}

// Score 0-4 → 4-segment bar. Label and segment colour share a tier.
const LABELS = ['Weak', 'Weak', 'Fair', 'Strong', 'Excellent'] as const;
const FILL = [
    'bg-destructive',
    'bg-destructive',
    'bg-yellow-500',
    'bg-green-500',
    'bg-green-600',
] as const;
const TEXT = [
    'text-destructive',
    'text-destructive',
    'text-yellow-600',
    'text-green-600',
    'text-green-700',
] as const;

export default function PasswordStrengthMeter({
    score,
    feedback = [],
    pwned = false,
    loading = false,
}: Props) {
    return (
        <div className="space-y-2">
            <div className="flex gap-1" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                    <div
                        key={i}
                        className={`h-1.5 flex-1 rounded-full ${
                            i < score ? FILL[score] : 'bg-muted'
                        }`}
                    />
                ))}
            </div>

            <p
                className={`text-xs ${loading ? 'text-muted-foreground' : TEXT[score]}`}
            >
                {loading ? 'Checking strength…' : `Strength: ${LABELS[score]}`}
            </p>

            {pwned && (
                <p className="text-xs text-destructive">
                    This password has appeared in a known data breach. Choose a
                    different one.
                </p>
            )}

            {feedback.length > 0 && (
                <ul className="list-disc pl-4 text-xs text-muted-foreground">
                    {feedback.map((f) => (
                        <li key={f}>{f}</li>
                    ))}
                </ul>
            )}
        </div>
    );
}
