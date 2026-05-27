import { useEffect, useRef, useState } from 'react';
import { loadScorer, type StrengthResult } from '@/lib/password-strength';

export interface PasswordStrength extends StrengthResult {
    loading: boolean;
}

const DEBOUNCE_MS = 250;
const EMPTY: StrengthResult = { score: 0, feedback: [], pwned: false };

/**
 * Debounced async password scoring. The zxcvbn-ts scorer is lazy-loaded
 * on first non-empty input (so it stays off every other route's
 * bundle); subsequent evaluations reuse it. Stale results from an
 * earlier keystroke are dropped via a sequence guard.
 */
export function usePasswordStrength(password: string): PasswordStrength {
    const [result, setResult] = useState<StrengthResult>(EMPTY);
    const [loading, setLoading] = useState(false);
    const seq = useRef(0);

    useEffect(() => {
        if (!password) {
            setResult(EMPTY);
            setLoading(false);
            return;
        }

        const id = ++seq.current;
        setLoading(true);

        const timer = setTimeout(async () => {
            try {
                const scorer = await loadScorer();
                const r = await scorer(password);
                if (seq.current === id) {
                    setResult(r);
                    setLoading(false);
                }
            } catch {
                if (seq.current === id) {
                    setResult(EMPTY);
                    setLoading(false);
                }
            }
        }, DEBOUNCE_MS);

        return () => clearTimeout(timer);
    }, [password]);

    return { ...result, loading };
}
