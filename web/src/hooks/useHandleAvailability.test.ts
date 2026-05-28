// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
    resolve: vi.fn(),
}));

describe('useHandleAvailability', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.clearAllMocks();
    });

    it('idle when handle is empty', async () => {
        const { useHandleAvailability } = await import(
            './useHandleAvailability'
        );
        const { result } = renderHook(() => useHandleAvailability(''));
        expect(result.current.status).toBe('idle');
    });

    it('invalid synchronously on shape violation (no resolve call)', async () => {
        const { resolve } = await import('@/lib/api');
        const { useHandleAvailability } = await import(
            './useHandleAvailability'
        );
        const { result } = renderHook(() => useHandleAvailability('Alice'));

        // Even after the debounce window elapses, resolve must not fire.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(1_000);
        });
        expect(result.current.status).toBe('invalid');
        expect(resolve).not.toHaveBeenCalled();
    });

    it('debounces resolve by 300ms — only the final value is checked', async () => {
        const { resolve } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({ status: 'not_found' });

        const { useHandleAvailability } = await import(
            './useHandleAvailability'
        );
        const { result, rerender } = renderHook(
            ({ h }: { h: string }) => useHandleAvailability(h),
            { initialProps: { h: 'a' } }, // invalid (too short) — won't fire timer
        );

        // Type a series of valid handles quickly. Each rerender clears the
        // previous timer; only the timer started by the final value matters.
        rerender({ h: 'ali' });
        rerender({ h: 'alic' });
        rerender({ h: 'alice' });
        rerender({ h: 'alice-' }); // invalid (trailing hyphen)
        rerender({ h: 'alice-t' });
        rerender({ h: 'alice-te' });
        rerender({ h: 'alice-tes' });
        rerender({ h: 'alice-test' });

        // Right before the debounce window elapses: status is "checking",
        // no resolve call yet.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(299);
        });
        expect(resolve).not.toHaveBeenCalled();
        expect(result.current.status).toBe('checking');

        // Cross the threshold: exactly one resolve call, with the final value.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(2);
        });
        expect(resolve).toHaveBeenCalledTimes(1);
        expect(resolve).toHaveBeenCalledWith('alice-test');
        expect(result.current.status).toBe('available');
    });

    it('renders taken on 200 live', async () => {
        const { resolve } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({
            status: 'live',
            user_id: 'u1',
            sharing_public_key: 'k',
        });
        const { useHandleAvailability } = await import(
            './useHandleAvailability'
        );
        const { result } = renderHook(() =>
            useHandleAvailability('alice-test'),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(result.current.status).toBe('taken');
        expect(result.current.message).toMatch(/Taken/);
    });

    it('renders released with the cooldown date on 410', async () => {
        const { resolve } = await import('@/lib/api');
        vi.mocked(resolve).mockResolvedValue({
            status: 'released',
            released_at: '2026-05-01T00:00:00Z',
            available_at: '2026-05-31T00:00:00Z',
        });
        const { useHandleAvailability } = await import(
            './useHandleAvailability'
        );
        const { result } = renderHook(() =>
            useHandleAvailability('recent-user'),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(result.current.status).toBe('released');
        expect(result.current.message).toContain('2026-05-31');
        expect(result.current.availableAt).toBe('2026-05-31T00:00:00Z');
    });

    it('renders error on resolve throw', async () => {
        const { resolve } = await import('@/lib/api');
        vi.mocked(resolve).mockRejectedValue(new Error('network'));
        const { useHandleAvailability } = await import(
            './useHandleAvailability'
        );
        const { result } = renderHook(() =>
            useHandleAvailability('alice-test'),
        );
        await act(async () => {
            await vi.advanceTimersByTimeAsync(400);
        });
        expect(result.current.status).toBe('error');
    });
});
