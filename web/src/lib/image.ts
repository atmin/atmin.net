/**
 * Client-side image re-encoding for optimized-by-default sends
 * (ADR-0022 §4/§5). A canvas round-trip strips all source metadata (EXIF incl.
 * GPS) and bakes the orientation tag into pixels, so an optimized image is both
 * smaller and metadata-clean for free. The primitive is reused by the preview
 * pipeline (P1b) and the receiver-side thumbnail (P1c).
 */

export const OPTIMIZED_MAX_EDGE = 2048;
export const OPTIMIZED_QUALITY = 0.8;

export interface Reencoded {
    blob: Blob;
    width: number;
    height: number;
}

// Raster types we can safely round-trip through a canvas. GIF is excluded
// (re-encoding would freeze an animation to a single JPEG frame) and SVG is
// excluded (vector — lossy to rasterize, and an XSS surface we don't want to
// round-trip). Everything else (PDF, audio, unknown) is a non-image and sent
// untouched.
const OPTIMIZABLE = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function isOptimizableImage(type: string): boolean {
    return OPTIMIZABLE.has(type);
}

/**
 * Fit (w, h) within a square of `maxEdge`, preserving aspect ratio and never
 * upscaling. The pure, directly-testable core of the scaling math (canvas and
 * `createImageBitmap` are unavailable under the unit-test DOM).
 */
export function fitWithin(
    w: number,
    h: number,
    maxEdge: number,
): { width: number; height: number } {
    const longest = Math.max(w, h);
    if (longest <= maxEdge) return { width: w, height: h };
    const scale = maxEdge / longest;
    return {
        width: Math.max(1, Math.round(w * scale)),
        height: Math.max(1, Math.round(h * scale)),
    };
}

/**
 * Decode (honoring EXIF orientation), fit within `maxEdge`, re-encode as JPEG.
 * Rejects if the source can't be decoded (`createImageBitmap` throws) or the
 * canvas can't encode (`toBlob` yields null) — the caller decides the fallback
 * (see {@link import('../hooks/useChatSend')}). Never silently returns the
 * original bytes.
 */
export async function reencodeImage(
    src: Blob,
    opts: { maxEdge: number; quality: number },
): Promise<Reencoded> {
    const bitmap = await createImageBitmap(src, {
        imageOrientation: 'from-image',
    });
    try {
        const { width, height } = fitWithin(
            bitmap.width,
            bitmap.height,
            opts.maxEdge,
        );
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2d canvas context unavailable');
        ctx.drawImage(bitmap, 0, 0, width, height);
        const blob = await new Promise<Blob | null>((resolve) =>
            canvas.toBlob(resolve, 'image/jpeg', opts.quality),
        );
        if (!blob) throw new Error('canvas.toBlob returned null');
        return { blob, width, height };
    } finally {
        bitmap.close();
    }
}

/**
 * Read the displayed pixel dimensions of an arbitrary image blob without
 * re-encoding (the original/opt-out path doesn't touch the bytes but still
 * carries width/height for zero-layout-shift rendering). Orientation is applied
 * so the reported dimensions match what an `<img>` renders.
 */
export async function imageSize(
    src: Blob,
): Promise<{ width: number; height: number }> {
    const bitmap = await createImageBitmap(src, {
        imageOrientation: 'from-image',
    });
    try {
        return { width: bitmap.width, height: bitmap.height };
    } finally {
        bitmap.close();
    }
}
