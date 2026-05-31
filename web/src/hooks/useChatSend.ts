import { useState } from 'react';
import { uploadMedia } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { base64UrlEncode } from '@/lib/crypto';
import { syncAndPublish } from '@/lib/inbox-sync';
import { encryptMedia } from '@/lib/media';
import type { SessionManager } from '@/lib/megolm-session';
import { sendInnerPayload, sendTextMessage } from '@/lib/messaging';
import { resolveRecipient } from '@/lib/recipient';
import { useOnlineStatus } from './useOnlineStatus';

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
            const { recipientUserId, recipientPubKeyBytes } =
                await resolveRecipient(session, handle, isSaved);
            const enc = await encryptMedia(file);
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
                        size: file.size,
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
