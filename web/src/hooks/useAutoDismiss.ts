import { useEffect } from 'react';

// Call `onDismiss` once, `ms` after `active` becomes true. Re-arms if `active`
// toggles. Used for one-shot transient notices (e.g. the post-deletion
// confirmation on Landing) so a component stays free of timer side-effects.
export function useAutoDismiss(
    active: boolean,
    onDismiss: () => void,
    ms: number,
): void {
    useEffect(() => {
        if (!active) return;
        const t = setTimeout(onDismiss, ms);
        return () => clearTimeout(t);
    }, [active, onDismiss, ms]);
}
