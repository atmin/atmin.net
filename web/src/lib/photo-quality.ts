/**
 * Persisted, device-local photo-send quality preference (ADR-0022 §4).
 *
 * The default (`optimized`) downscales + re-encodes + strips metadata; the
 * opt-out (`original`) sends the untouched bytes. A per-send override is
 * deferred to the album composer (Phase 2) — this is the single global setting.
 *
 * Leaf module: the single source of truth for the storage key + default. Read
 * by {@link import('../hooks/useChatSend')} at send time and by
 * {@link import('../hooks/usePhotoQuality')} for the Settings UI.
 */

export type PhotoQuality = 'optimized' | 'original';

export const PHOTO_QUALITY_KEY = 'atmin:photo-quality';

export function getPhotoQuality(): PhotoQuality {
    return localStorage.getItem(PHOTO_QUALITY_KEY) === 'original'
        ? 'original'
        : 'optimized';
}

export function setPhotoQuality(quality: PhotoQuality): void {
    localStorage.setItem(PHOTO_QUALITY_KEY, quality);
}
