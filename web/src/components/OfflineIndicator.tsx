export function OfflineIndicator() {
    return (
        <div
            data-testid="offline-indicator"
            className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-lg border bg-background px-4 py-2 shadow-lg text-sm"
        >
            <span>You are offline</span>
        </div>
    );
}
