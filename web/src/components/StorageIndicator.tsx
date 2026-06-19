import { Block, BlockTitle, Progressbar } from 'konsta/react';
import type { StorageUsage } from '@/lib/api';
import { formatBytes } from '@/lib/utils';

interface Props {
    usage: StorageUsage | null;
    loading: boolean;
}

// Storage-used section for settings. Progress bar + line; turns red and nudges
// once usage crosses 90% of quota (v0.1 has no media GC, so this is the user's
// only signal of pressure).
export function StorageIndicator({ usage, loading }: Props) {
    if (loading) {
        return (
            <Block className="text-sm opacity-60">Loading storage usage…</Block>
        );
    }
    if (!usage) return null;

    const ratio =
        usage.quota_bytes > 0 ? usage.used_bytes / usage.quota_bytes : 0;
    const warn = ratio >= 0.9;
    return (
        <>
            <BlockTitle>Storage</BlockTitle>
            <Block
                strong
                inset
                data-testid="storage-indicator"
                className={warn ? 'text-red-500' : ''}
            >
                <Progressbar progress={Math.min(ratio, 1)} />
                <p className="mt-2 text-sm">
                    {formatBytes(usage.used_bytes)} /{' '}
                    {formatBytes(usage.quota_bytes)} ({usage.blob_count}{' '}
                    {usage.blob_count === 1 ? 'file' : 'files'})
                    {warn && ' — approaching storage limit.'}
                </p>
            </Block>
        </>
    );
}
