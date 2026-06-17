// @vitest-environment happy-dom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '@/test/storage';
import { useDraft } from './useDraft';

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
