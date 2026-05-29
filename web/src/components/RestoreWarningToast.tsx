interface Props {
    /** Number of session keys that couldn't be restored on this device. */
    count: number;
    onDismiss: () => void;
}

/**
 * Surfaces partial history loss after a restore (I6): some key-backup
 * blobs were present but couldn't be decrypted (corrupt/undecryptable),
 * so those conversations' history won't appear on this device. Shown
 * once per session rather than failing the whole login — one bad blob
 * must not block recovering everything else.
 */
export function RestoreWarningToast({ count, onDismiss }: Props) {
    return (
        <div
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border border-destructive/40 bg-background px-4 py-2 shadow-lg text-sm"
            role="alert"
            data-testid="restore-warning"
        >
            <span>
                {count === 1
                    ? "1 conversation's history couldn't be restored on this device."
                    : `${count} conversations' history couldn't be restored on this device.`}
            </span>
            <button
                type="button"
                onClick={onDismiss}
                aria-label="Dismiss"
                className="text-muted-foreground hover:text-foreground"
            >
                ✕
            </button>
        </div>
    );
}
