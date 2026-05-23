import { useState } from 'react';
import { resolve, uploadMedia } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { base64UrlDecode, base64UrlEncode } from '@/lib/crypto';
import { syncAndPublish } from '@/lib/inbox-sync';
import { encryptMedia } from '@/lib/media';
import type { SessionManager } from '@/lib/megolm-session';
import { sendTextMessage } from '@/lib/messaging';
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

    async function resolveRecipient(): Promise<{
        recipientUserId: string;
        recipientPubKeyBytes: Uint8Array;
    }> {
        if (isSaved) {
            return {
                recipientUserId: session.userId,
                recipientPubKeyBytes: session.sharingPublicKeyBytes,
            };
        }
        if (!handle) throw new Error('No recipient handle');
        const res = await resolve(handle);
        return {
            recipientUserId: res.user_id,
            recipientPubKeyBytes: base64UrlDecode(res.sharing_public_key),
        };
    }

    async function sendAndSync(
        mgr: SessionManager,
        envelopeText: string,
        recipientUserId: string,
        recipientPubKeyBytes: Uint8Array,
    ): Promise<void> {
        await sendTextMessage(
            session.token,
            session.userId,
            session.deviceId,
            recipientUserId,
            recipientPubKeyBytes,
            session.sharingPublicKeyBytes,
            envelopeText,
            mgr,
        );
        await syncAndPublish(session, mgr);
    }

    const sendText = async (text: string) => {
        if (!text || sending || !sessionManager || !online) return;
        setSending(true);
        try {
            const { recipientUserId, recipientPubKeyBytes } =
                await resolveRecipient();
            await sendAndSync(
                sessionManager,
                text,
                recipientUserId,
                recipientPubKeyBytes,
            );
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
                await resolveRecipient();
            const enc = await encryptMedia(file);
            const { url } = await uploadMedia(
                session.token,
                session.userId,
                enc,
            );
            const envelope = JSON.stringify({
                type: 'media',
                body: file.name,
                file: {
                    url,
                    key: base64UrlEncode(enc.key),
                    iv: base64UrlEncode(enc.iv),
                    name: file.name,
                    size: file.size,
                },
            });
            await sendAndSync(
                sessionManager,
                envelope,
                recipientUserId,
                recipientPubKeyBytes,
            );
        } catch (error) {
            console.error('Failed to send media:', error);
            alert('Failed to send attachment. Please try again.');
        } finally {
            setSending(false);
        }
    };

    return { sending, online, sendText, sendMedia };
}
