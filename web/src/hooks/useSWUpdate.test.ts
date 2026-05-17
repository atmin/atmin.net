// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateServiceWorker = vi.fn();
const setNeedRefresh = vi.fn();

vi.mock('virtual:pwa-register/react', () => ({
    useRegisterSW: vi.fn().mockReturnValue({
        needRefresh: [false, setNeedRefresh],
        updateServiceWorker,
    }),
}));

describe('useSWUpdate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('exposes needRefresh, onUpdate, and onDismiss', async () => {
        const { useSWUpdate } = await import('./useSWUpdate');
        const { result } = renderHook(() => useSWUpdate(false));

        expect(result.current.needRefresh).toBe(false);
        expect(typeof result.current.onUpdate).toBe('function');
        expect(typeof result.current.onDismiss).toBe('function');
    });

    it('onUpdate calls updateServiceWorker(true)', async () => {
        const { useSWUpdate } = await import('./useSWUpdate');
        const { result } = renderHook(() => useSWUpdate(false));

        act(() => {
            result.current.onUpdate();
        });

        expect(updateServiceWorker).toHaveBeenCalledWith(true);
    });

    it('onDismiss calls setNeedRefresh(false)', async () => {
        const { useSWUpdate } = await import('./useSWUpdate');
        const { result } = renderHook(() => useSWUpdate(false));

        act(() => {
            result.current.onDismiss();
        });

        expect(setNeedRefresh).toHaveBeenCalledWith(false);
    });

    it('auto-updates when needRefresh=true, sending=false, no draft', async () => {
        const { useRegisterSW } = await import('virtual:pwa-register/react');
        vi.mocked(useRegisterSW).mockReturnValue({
            needRefresh: [true, setNeedRefresh],
            offlineReady: [false, vi.fn()],
            updateServiceWorker,
        });

        const { useSWUpdate } = await import('./useSWUpdate');
        const { result } = renderHook(() => useSWUpdate(false));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        // result returned; auto-update effect should have fired
        expect(result.current.needRefresh).toBe(true);
        expect(updateServiceWorker).toHaveBeenCalledWith(true);
    });

    it('does not auto-update when sending=true', async () => {
        const { useRegisterSW } = await import('virtual:pwa-register/react');
        vi.mocked(useRegisterSW).mockReturnValue({
            needRefresh: [true, setNeedRefresh],
            offlineReady: [false, vi.fn()],
            updateServiceWorker,
        });

        const { useSWUpdate } = await import('./useSWUpdate');
        renderHook(() => useSWUpdate(true));

        await act(async () => {
            await new Promise((r) => setTimeout(r, 0));
        });

        expect(updateServiceWorker).not.toHaveBeenCalled();
    });
});
