import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { memoryStorage } from '@/test/storage';
import {
    getPhotoQuality,
    PHOTO_QUALITY_KEY,
    setPhotoQuality,
} from './photo-quality';

describe('photo-quality preference', () => {
    beforeEach(() => {
        vi.stubGlobal('localStorage', memoryStorage());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('defaults to optimized when nothing is stored', () => {
        expect(getPhotoQuality()).toBe('optimized');
    });

    it('round-trips set → get', () => {
        setPhotoQuality('original');
        expect(getPhotoQuality()).toBe('original');
        expect(localStorage.getItem(PHOTO_QUALITY_KEY)).toBe('original');

        setPhotoQuality('optimized');
        expect(getPhotoQuality()).toBe('optimized');
    });

    it('treats any unrecognized stored value as optimized', () => {
        localStorage.setItem(PHOTO_QUALITY_KEY, 'garbage');
        expect(getPhotoQuality()).toBe('optimized');
    });
});
