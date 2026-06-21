// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '@/test/storage';
import { useDrafts } from './useDrafts';

describe('useDrafts', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', memoryStorage());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('is empty when no drafts are stored', () => {
        const { result } = renderHook(() => useDrafts());
        expect(result.current.size).toBe(0);
    });

    it('collects every draft key, stripped of the prefix, into a handle→text map', () => {
        localStorage.setItem('atmin:draft:alice', 'hi alice');
        localStorage.setItem('atmin:draft:saved', 'note to self');
        const { result } = renderHook(() => useDrafts());
        expect(result.current.get('alice')).toBe('hi alice');
        expect(result.current.get('saved')).toBe('note to self');
        expect(result.current.size).toBe(2);
    });

    it('ignores unrelated localStorage keys', () => {
        localStorage.setItem('atmin:draft:bob', 'for bob');
        localStorage.setItem('atmin:photoQuality', 'original');
        localStorage.setItem('some-other-key', 'value');
        const { result } = renderHook(() => useDrafts());
        expect(result.current.size).toBe(1);
        expect(result.current.get('bob')).toBe('for bob');
    });
});
