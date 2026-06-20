import { Toast } from 'konsta/react';
import { TriangleAlert } from 'lucide-react';

interface Props {
    /** Number of session keys that couldn't be restored on this device. */
    count: number;
    onDismiss: () => void;
}

// iOS draws its frosted surface from the trimmed `glass` style (T0), so give it
// the explicit frosted recipe; Material keeps its tonal surface-5. See
// OfflineIndicator for the shared rationale.
const OVERLAY_COLORS = {
    bgIos: 'bg-white/80 shadow-lg backdrop-blur-xl dark:bg-[#1c1c1e]/80',
    textIos: 'text-foreground',
    textMaterial: 'text-foreground',
};

/**
 * Surfaces partial history loss after a restore (I6): some key-backup
 * blobs were present but couldn't be decrypted (corrupt/undecryptable),
 * so those conversations' history won't appear on this device. Shown
 * once per session rather than failing the whole login — one bad blob
 * must not block recovering everything else.
 */
export function RestoreWarningToast({ count, onDismiss }: Props) {
    return (
        <Toast
            opened
            position="center"
            colors={OVERLAY_COLORS}
            role="alert"
            data-testid="restore-warning"
            button={
                <button
                    type="button"
                    onClick={onDismiss}
                    aria-label="Dismiss"
                    className="font-medium text-primary"
                >
                    Dismiss
                </button>
            }
        >
            <span className="flex items-center gap-2 text-sm">
                <TriangleAlert className="size-4 shrink-0 text-amber-500" />
                {count === 1
                    ? "1 conversation's history couldn't be restored on this device."
                    : `${count} conversations' history couldn't be restored on this device.`}
            </span>
        </Toast>
    );
}
