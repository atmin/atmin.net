import { describe, expect, it } from 'vitest';
import {
    fitWithin,
    isOptimizableImage,
    needsPreview,
    OPTIMIZED_MAX_EDGE,
} from './image';

describe('fitWithin', () => {
    it('never upscales an image already within the cap', () => {
        expect(fitWithin(800, 600, 2048)).toEqual({ width: 800, height: 600 });
        expect(fitWithin(2048, 1536, 2048)).toEqual({
            width: 2048,
            height: 1536,
        });
    });

    it('scales the longest edge down to the cap, preserving aspect ratio', () => {
        // Landscape: longest edge is width.
        expect(fitWithin(4096, 3072, 2048)).toEqual({
            width: 2048,
            height: 1536,
        });
        // Portrait: longest edge is height.
        expect(fitWithin(3000, 6000, 2048)).toEqual({
            width: 1024,
            height: 2048,
        });
    });

    it('rounds and never collapses a dimension below 1px', () => {
        const { width, height } = fitWithin(10000, 3, OPTIMIZED_MAX_EDGE);
        expect(width).toBe(2048);
        expect(height).toBe(1); // round(3 * 2048/10000) = round(0.6) = 1, floored at 1
    });
});

describe('isOptimizableImage', () => {
    it('accepts the raster types a canvas can safely round-trip', () => {
        expect(isOptimizableImage('image/jpeg')).toBe(true);
        expect(isOptimizableImage('image/png')).toBe(true);
        expect(isOptimizableImage('image/webp')).toBe(true);
    });

    it('rejects GIF (would freeze animation) and SVG (vector / XSS surface)', () => {
        expect(isOptimizableImage('image/gif')).toBe(false);
        expect(isOptimizableImage('image/svg+xml')).toBe(false);
    });

    it('rejects non-images and unknown types', () => {
        expect(isOptimizableImage('application/pdf')).toBe(false);
        expect(isOptimizableImage('')).toBe(false);
        expect(isOptimizableImage('video/mp4')).toBe(false);
    });
});

describe('needsPreview', () => {
    it('is true over the byte threshold (>100 KB)', () => {
        expect(needsPreview(101 * 1024, 800, 600)).toBe(true);
    });

    it('is true over the edge threshold (>1024 px)', () => {
        expect(needsPreview(20 * 1024, 2048, 1536)).toBe(true);
        expect(needsPreview(20 * 1024, 600, 1200)).toBe(true); // tall
    });

    it('is false when small in both bytes and dimensions', () => {
        expect(needsPreview(50 * 1024, 800, 600)).toBe(false);
        expect(needsPreview(74, 8, 8)).toBe(false); // the e2e fixture
        expect(needsPreview(100 * 1024, 1024, 1024)).toBe(false); // exactly at caps
    });
});
