// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDraft } from './useDraft';

// Install a fresh in-memory localStorage per test rather than relying on the
// ambient one. The unit project runs in node (DOM comes only from the
// per-file happy-dom directive); a sibling test file that defineProperty's
// globalThis.localStorage can otherwise leak across files in a reused CI
// worker, so we stub our own deterministic Storage and restore after.
function memoryStorage(): Storage {
    const m = new Map<string, string>();
    return {
        get length() {
            return m.size;
        },
        clear: () => m.clear(),
        getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
        key: (i) => [...m.keys()][i] ?? null,
        removeItem: (k) => {
            m.delete(k);
        },
        setItem: (k, v) => {
            m.set(k, String(v));
        },
    };
}

describe('useDraft', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', memoryStorage());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('is empty when no draft is stored', () => {
        const { result } = renderHook(() => useDraft('alice'));
        expect(result.current[0]).toBe('');
    });

    it('initialises from localStorage', () => {
        localStorage.setItem('atmin:draft:alice', 'hi');
        const { result } = renderHook(() => useDraft('alice'));
        expect(result.current[0]).toBe('hi');
    });

    it('setValue writes through to localStorage', () => {
        const { result } = renderHook(() => useDraft('alice'));
        act(() => result.current[1]('hello'));
        expect(result.current[0]).toBe('hello');
        expect(localStorage.getItem('atmin:draft:alice')).toBe('hello');
    });

    it("setValue('') removes the key", () => {
        localStorage.setItem('atmin:draft:alice', 'seed');
        const { result } = renderHook(() => useDraft('alice'));
        act(() => result.current[1](''));
        expect(result.current[0]).toBe('');
        expect(localStorage.getItem('atmin:draft:alice')).toBeNull();
    });

    it('reloads from the new key when the handle changes', () => {
        localStorage.setItem('atmin:draft:alice', 'for alice');
        localStorage.setItem('atmin:draft:bob', 'for bob');
        const { result, rerender } = renderHook(({ h }) => useDraft(h), {
            initialProps: { h: 'alice' },
        });
        expect(result.current[0]).toBe('for alice');
        rerender({ h: 'bob' });
        expect(result.current[0]).toBe('for bob');
    });

    it('resets to empty when the new handle has no stored draft', () => {
        localStorage.setItem('atmin:draft:alice', 'for alice');
        const { result, rerender } = renderHook(({ h }) => useDraft(h), {
            initialProps: { h: 'alice' },
        });
        expect(result.current[0]).toBe('for alice');
        rerender({ h: 'bob' });
        expect(result.current[0]).toBe('');
    });
});
