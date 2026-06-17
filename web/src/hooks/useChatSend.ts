import { useState } from 'react';
import { uploadMedia } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { base64UrlEncode } from '@/lib/crypto';
import {
    imageSize,
    isOptimizableImage,
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

// Decide which bytes to send for `file` and which optional wire fields to
// attach, per the photo-quality setting (ADR-0022 §4/§5):
//   - genuine non-image  → untouched bytes, no new fields (v0.1 behaviour);
//   - GIF/SVG or "original quality" → untouched bytes, labelled + dimensioned;
//   - optimizable image (default)   → downscaled + re-encoded JPEG (EXIF
//     stripped for free), falling back to the original on a re-encode failure.
async function prepareMediaForSend(
    file: File,
): Promise<{ blob: Blob; extras: MediaFileExtras }> {
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

    if (!isOptimizableImage(file.type) || getPhotoQuality() === 'original') {
        return original();
    }

    try {
        const r = await reencodeImage(file, {
            maxEdge: OPTIMIZED_MAX_EDGE,
            quality: OPTIMIZED_QUALITY,
        });
        return {
            blob: r.blob,
            extras: {
                mime: 'image/jpeg',
                optimized: true,
                width: r.width,
                height: r.height,
            },
        };
    } catch (e) {
        console.warn('Image re-encode failed; sending original:', e);
        return original();
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
    sendMedia: (file: File) => Promise<void>;
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

    const sendMedia = async (file: File) => {
        if (sending || !sessionManager || !online) return;
        setSending(true);
        try {
            // Guard the source up front: the optimized path hands encryptMedia
            // the shrunken blob, so its own cap would let a huge original
            // through and choke the canvas first.
            if (file.size > MAX_MEDIA_BYTES) throw new FileTooLargeError();

            const { recipientUserId, recipientPubKeyBytes } =
                await resolveRecipient(session, handle, isSaved);
            const { blob, extras } = await prepareMediaForSend(file);
            const enc = await encryptMedia(blob);
            const { url } = await uploadMedia(
                session.token,
                session.userId,
                enc,
            );
            await sendInnerPayload(
                session.token,
                session.userId,
                session.deviceId,
                recipientUserId,
                recipientPubKeyBytes,
                session.sharingPublicKeyBytes,
                {
                    type: 'media',
                    body: file.name,
                    file: {
                        url,
                        key: base64UrlEncode(enc.key),
                        iv: base64UrlEncode(enc.iv),
                        name: file.name,
                        size: enc.plaintextSize,
                        ...extras,
                    },
                },
                sessionManager,
            );
            await syncAndPublish(session, sessionManager);
        } catch (error) {
            console.error('Failed to send media:', error);
            alert('Failed to send attachment. Please try again.');
        } finally {
            setSending(false);
        }
    };

    return { sending, online, sendText, sendMedia };
}
