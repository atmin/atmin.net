import { useEffect, useState } from 'react';
import { getStorageUsage, type StorageUsage } from '@/lib/api';

export interface StorageUsageState {
    usage: StorageUsage | null;
    loading: boolean;
    error: string | null;
}

// Fetch the caller's media usage once per token, for the settings indicator.
// Mirrors the useDevices shape: the hook owns fetch state, the component is
// presentational.
export function useStorageUsage(token: string): StorageUsageState {
    const [usage, setUsage] = useState<StorageUsage | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        getStorageUsage(token)
            .then((u) => {
                if (!cancelled) setUsage(u);
            })
            .catch((e) => {
                if (!cancelled) {
                    setError(
                        e instanceof Error ? e.message : 'Failed to load usage',
                    );
                }
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [token]);

    return { usage, loading, error };
}
