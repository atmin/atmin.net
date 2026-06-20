import { Toast } from 'konsta/react';
import { Download } from 'lucide-react';

interface Props {
    sending: boolean;
    onUpdate: () => void;
    onDismiss: () => void;
}

// iOS draws its frosted surface from the trimmed `glass` style (T0), so give it
// the explicit frosted recipe; Material keeps its tonal surface-5. Text is
// neutralised (Material's default is accent-coloured) — the Reload action keeps
// the accent. See OfflineIndicator for the shared rationale.
const OVERLAY_COLORS = {
    bgIos: 'bg-white/80 shadow-lg backdrop-blur-xl dark:bg-[#1c1c1e]/80',
    textIos: 'text-foreground',
    textMaterial: 'text-foreground',
};

export function SWUpdateToast({ sending, onUpdate, onDismiss }: Props) {
    return (
        <Toast
            opened
            position="center"
            colors={OVERLAY_COLORS}
            button={
                <div className="flex items-center gap-3">
                    <button
                        type="button"
                        className="font-medium text-primary disabled:opacity-40"
                        disabled={sending}
                        onClick={onUpdate}
                    >
                        {sending ? 'Sending…' : 'Reload'}
                    </button>
                    <button
                        type="button"
                        onClick={onDismiss}
                        aria-label="Dismiss"
                        className="opacity-50 active:opacity-100"
                    >
                        ✕
                    </button>
                </div>
            }
        >
            <span className="flex items-center gap-2 text-sm">
                <Download className="size-4 shrink-0 opacity-70" />
                Update available
            </span>
        </Toast>
    );
}
