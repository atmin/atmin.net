import { useState } from 'react';
import { uploadMedia } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { base64UrlEncode } from '@/lib/crypto';
import {
    imageSize,
    isOptimizableImage,
    makePreview,
    needsPreview,
    OPTIMIZED_MAX_EDGE,
    OPTIMIZED_QUALITY,
    reencodeImage,
} from '@/lib/image';
import { syncAndPublish } from '@/lib/inbox-sync';
import {
    encryptMedia,
    FileTooLargeError,
    MAX_MEDIA_BYTES,
    type MediaFileExtras,
} from '@/lib/media';
import type { SessionManager } from '@/lib/megolm-session';
import { sendInnerPayload, sendTextMessage } from '@/lib/messaging';
import { getPhotoQuality } from '@/lib/photo-quality';
import { resolveRecipient } from '@/lib/recipient';
import { useOnlineStatus } from './useOnlineStatus';

// Best-effort dimensions; an undecodable image just omits them (the wire fields
// are all optional, so a missing size only forgoes the layout-shift hint).
async function dimensions(blob: Blob): Promise<MediaFileExtras> {
    try {
        return await imageSize(blob);
    } catch {
        return {};
    }
}

interface PreparedMedia {
    blob: Blob; // the full bytes to encrypt + upload
    extras: MediaFileExtras; // mime / width / height / optimized
    preview?: { blob: Blob; width: number; height: number };
}

// Raised when the optimized (default) path cannot strip metadata via canvas.
// We FAIL CLOSED rather than fall back to the untouched original: the default
// promises metadata-clean sends (ADR-0022 §5), so silently shipping the EXIF
// (incl. GPS) on a re-encode failure would be a privacy leak the user never
// chose. The explicit, labelled "Original quality" opt-out is how a user sends
// untouched bytes on purpose.
class ImageOptimizeError extends Error {
    constructor(readonly reason: unknown) {
        super('image optimization failed');
        this.name = 'ImageOptimizeError';
    }
}

// Decide which bytes to send for the full `file`, which optional wire fields to
// attach, and whether to attach a separate preview, per the photo-quality
// setting (ADR-0022 §3/§4/§5):
//   - genuine non-image  → untouched bytes, no new fields (v0.1 behaviour);
//   - GIF/SVG or "original quality" → untouched bytes, labelled + dimensioned;
//   - optimizable image (default)   → downscaled + re-encoded JPEG (EXIF
//     stripped for free); a re-encode failure throws ImageOptimizeError rather
//     than leaking the un-stripped original.
// A conditional preview is generated from the stored full for canvas-encodable
// rasters over the threshold (§3).
async function prepareMediaForSend(file: File): Promise<PreparedMedia> {
    if (!file.type.startsWith('image/')) return { blob: file, extras: {} };

    const original = async (): Promise<{
        blob: Blob;
        extras: MediaFileExtras;
    }> => ({
        blob: file,
        extras: {
            mime: file.type,
            optimized: false,
            ...(await dimensions(file)),
        },
    });

    let full: { blob: Blob; extras: MediaFileExtras };
    if (!isOptimizableImage(file.type) || getPhotoQuality() === 'original') {
        full = await original();
    } else {
        try {
            const r = await reencodeImage(file, {
                maxEdge: OPTIMIZED_MAX_EDGE,
                quality: OPTIMIZED_QUALITY,
            });
            full = {
                blob: r.blob,
                extras: {
                    mime: 'image/jpeg',
                    optimized: true,
                    width: r.width,
                    height: r.height,
                },
            };
        } catch (e) {
            // Do NOT fall back to original() here — that would ship the EXIF
            // the optimized default promised to strip. Fail closed.
            throw new ImageOptimizeError(e);
        }
    }

    return { ...full, preview: await maybePreview(file.type, full) };
}

// A conditional preview from the stored full — only for canvas-encodable rasters
// whose full is over the threshold (ADR-0022 §3). Generation failure just omits
// it (the full renders directly).
async function maybePreview(
    type: string,
    full: { blob: Blob; extras: MediaFileExtras },
): Promise<{ blob: Blob; width: number; height: number } | undefined> {
    const { width, height } = full.extras;
    if (
        !isOptimizableImage(type) ||
        width === undefined ||
        height === undefined
    )
        return undefined;
    if (!needsPreview(full.blob.size, width, height)) return undefined;
    try {
        const r = await makePreview(full.blob);
        return { blob: r.blob, width: r.width, height: r.height };
    } catch (e) {
        console.warn('Preview generation failed; sending without preview:', e);
        return undefined;
    }
}

export function useChatSend(
    handle: string | undefined,
    isSaved: boolean,
    session: Session,
    sessionManager: SessionManager | null,
): {
    sending: boolean;
    online: boolean;
    sendText: (text: string) => Promise<void>;
    sendMedia: (file: File, caption?: string) => Promise<void>;
} {
    const [sending, setSending] = useState(false);
    const online = useOnlineStatus();

    const sendText = async (text: string) => {
        if (!text || sending || !sessionManager || !online) return;
        setSending(true);
        try {
            const { recipientUserId, recipientPubKeyBytes } =
                await resolveRecipient(session, handle, isSaved);
            await sendTextMessage(
                session.token,
                session.userId,
                session.deviceId,
                recipientUserId,
                recipientPubKeyBytes,
                session.sharingPublicKeyBytes,
                text,
                sessionManager,
            );
            await syncAndPublish(session, sessionManager);
        } catch (error) {
            console.error('Failed to send message:', error);
            alert('Failed to send message. Please try again.');
        } finally {
            setSending(false);
        }
    };

    const sendMedia = async (file: File, caption?: string) => {
        if (sending || !sessionManager || !online) return;
        setSending(true);
        try {
            // Guard the source up front: the optimized path hands encryptMedia
            // the shrunken blob, so its own cap would let a huge original
            // through and choke the canvas first.
            if (file.size > MAX_MEDIA_BYTES) throw new FileTooLargeError();

            const { recipientUserId, recipientPubKeyBytes } =
                await resolveRecipient(session, handle, isSaved);
            const { blob, extras, preview } = await prepareMediaForSend(file);

            const encryptAndUpload = async (b: Blob) => {
                const enc = await encryptMedia(b);
                const { url } = await uploadMedia(
                    session.token,
                    session.userId,
                    enc,
                );
                return { url, enc };
            };

            // Upload-then-send: full + preview both PUT before the envelope, so
            // a failed send orphans them for the cleanup sweep (ADR-0006), never
            // a half-referenced message.
            const [full, prev] = await Promise.all([
                encryptAndUpload(blob),
                preview
                    ? encryptAndUpload(preview.blob)
                    : Promise.resolve(null),
            ]);

            await sendInnerPayload(
                session.token,
                session.userId,
                session.deviceId,
                recipientUserId,
                recipientPubKeyBytes,
                session.sharingPublicKeyBytes,
                {
                    type: 'media',
                    // Companion message from the compose tray; the filename is
                    // the fallback so a caption-less send is unchanged (P1d).
                    body: caption?.trim() || file.name,
                    file: {
                        url: full.url,
                        key: base64UrlEncode(full.enc.key),
                        iv: base64UrlEncode(full.enc.iv),
                        name: file.name,
                        size: full.enc.plaintextSize,
                        ...extras,
                        ...(prev && preview
                            ? {
                                  preview: {
                                      url: prev.url,
                                      key: base64UrlEncode(prev.enc.key),
                                      iv: base64UrlEncode(prev.enc.iv),
                                      width: preview.width,
                                      height: preview.height,
                                  },
                              }
                            : {}),
                    },
                },
                sessionManager,
            );
            await syncAndPublish(session, sessionManager);
        } catch (error) {
            if (error instanceof ImageOptimizeError) {
                // Fail closed: the optimized default couldn't strip metadata, so
                // we refuse to silently send the original. Offer the explicit,
                // labelled opt-out instead.
                console.warn('Image optimization failed:', error.reason);
                alert(
                    "Couldn't process this image. To send it unchanged — which keeps its metadata (e.g. location) — switch to Original quality in Settings.",
                );
            } else {
                console.error('Failed to send media:', error);
                alert('Failed to send attachment. Please try again.');
            }
        } finally {
            setSending(false);
        }
    };

    return { sending, online, sendText, sendMedia };
}
