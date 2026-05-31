import type { StorageUsage } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

interface Props {
    usage: StorageUsage | null;
    loading: boolean;
}

// Presentational storage-used line for settings. Turns destructive + adds a
// nudge once usage crosses 90% of quota (v0.1 has no media GC, so this is the
// user's only signal of pressure).
export function StorageIndicator({ usage, loading }: Props) {
    if (loading) {
        return (
            <div className="text-sm text-muted-foreground">
                Loading storage usage…
            </div>
        );
    }
    if (!usage) return null;

    const warn = usage.used_bytes / usage.quota_bytes >= 0.9;
    return (
        <div
            data-testid="storage-indicator"
            className={
                warn
                    ? 'text-sm text-destructive'
                    : 'text-sm text-muted-foreground'
            }
        >
            Storage: {formatBytes(usage.used_bytes)} /{' '}
            {formatBytes(usage.quota_bytes)} ({usage.blob_count}{' '}
            {usage.blob_count === 1 ? 'file' : 'files'})
            {warn && <span className="ml-2">Approaching storage limit.</span>}
        </div>
    );
}
