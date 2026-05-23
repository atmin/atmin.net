// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useOnlineStatus } from './useOnlineStatus';

describe('useOnlineStatus', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('initialises from navigator.onLine', () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
        const { result } = renderHook(() => useOnlineStatus());
        expect(result.current).toBe(true);
    });

    it('flips to false on window offline event', () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
        const { result } = renderHook(() => useOnlineStatus());

        act(() => {
            window.dispatchEvent(new Event('offline'));
        });

        expect(result.current).toBe(false);
    });

    it('flips to true on window online event', () => {
        vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
        const { result } = renderHook(() => useOnlineStatus());
        expect(result.current).toBe(false);

        act(() => {
            window.dispatchEvent(new Event('online'));
        });

        expect(result.current).toBe(true);
    });

    it('removes listeners on unmount', () => {
        const removeSpy = vi.spyOn(window, 'removeEventListener');
        const { unmount } = renderHook(() => useOnlineStatus());

        unmount();

        const types = removeSpy.mock.calls.map((c) => c[0]);
        expect(types).toContain('online');
        expect(types).toContain('offline');
    });
});
