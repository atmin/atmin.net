import { Toast } from 'konsta/react';
import { CloudOff } from 'lucide-react';

// iOS Toast/Notification draw their frosted surface from the Glass component,
// whose `glass` style was trimmed from our theme (ADR-0023 / T0). Give iOS the
// standard frosted surface explicitly (same recipe as the T4b actions sheet) and
// neutralise Material's accent-coloured text — these are status pills, not
// accent toasts. Material keeps its tonal surface-5 background.
const OVERLAY_COLORS = {
    bgIos: 'bg-white/80 shadow-lg backdrop-blur-xl dark:bg-[#1c1c1e]/80',
    textIos: 'text-foreground',
    textMaterial: 'text-foreground',
};

export function OfflineIndicator() {
    return (
        <Toast
            opened
            position="center"
            colors={OVERLAY_COLORS}
            data-testid="offline-indicator"
        >
            <span className="flex items-center gap-2 text-sm">
                <CloudOff className="size-4 shrink-0 opacity-70" />
                You are offline
            </span>
        </Toast>
    );
}
