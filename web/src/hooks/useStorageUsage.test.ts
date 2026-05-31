// @vitest-environment happy-dom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    getStorageUsage: vi.fn(),
}));

import { getStorageUsage } from '@/lib/api';
import { useStorageUsage } from './useStorageUsage';

const usage = {
    used_bytes: 1024,
    quota_bytes: 1 << 30,
    blob_count: 1,
    quota_blob_cap: 1000,
};

describe('useStorageUsage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('transitions loading → loaded', async () => {
        vi.mocked(getStorageUsage).mockResolvedValue(usage);
        const { result } = renderHook(() => useStorageUsage('tok'));

        expect(result.current.loading).toBe(true);
        expect(result.current.usage).toBeNull();

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.usage).toEqual(usage);
        expect(result.current.error).toBeNull();
        expect(getStorageUsage).toHaveBeenCalledWith('tok');
    });

    it('sets error and leaves usage null on failure', async () => {
        vi.mocked(getStorageUsage).mockRejectedValue(new Error('boom'));
        const { result } = renderHook(() => useStorageUsage('tok'));

        await waitFor(() => expect(result.current.loading).toBe(false));
        expect(result.current.usage).toBeNull();
        expect(result.current.error).toBe('boom');
    });
});
