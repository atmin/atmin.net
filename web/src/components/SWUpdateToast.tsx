interface Props {
    sending: boolean;
    onUpdate: () => void;
    onDismiss: () => void;
}

export function SWUpdateToast({ sending, onUpdate, onDismiss }: Props) {
    return (
        <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg text-sm">
            <span>Update available</span>
            <button
                type="button"
                className="font-medium underline disabled:opacity-40"
                disabled={sending}
                onClick={onUpdate}
            >
                {sending ? 'Sending…' : 'Reload'}
            </button>
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
