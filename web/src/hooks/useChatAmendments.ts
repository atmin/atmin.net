import { useState } from 'react';
import { sendAmendment } from '@/lib/amendments';
import { storeDelete } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { syncAndPublish } from '@/lib/inbox-sync';
import type { SessionManager } from '@/lib/megolm-session';
import type { AmendmentAction } from '@/lib/messaging';
import { resolveRecipient } from '@/lib/recipient';
import { useOnlineStatus } from './useOnlineStatus';

export interface ChatAmendments {
    busy: boolean;
    editMessage: (msgId: string, newBody: string) => Promise<void>;
    deleteMessage: (msgId: string, mediaUrls?: string[]) => Promise<void>;
}

// Edit/delete actions for the user's own messages. Both send an amendment
// envelope referencing the original by msg_id (ADR-0014). On delete of a media
// message the sender additionally drops the message's full S3 object set — the
// full and its preview (ADR-0022) — best-effort; the recipient's decrypted-blob
// cache is purged automatically by useMedia once the materializer removes the
// media reference from the message.
export function useChatAmendments(
    handle: string | undefined,
    isSaved: boolean,
    session: Session,
    sessionManager: SessionManager | null,
): ChatAmendments {
    const [busy, setBusy] = useState(false);
    const online = useOnlineStatus();

    async function amend(
        targetMsgId: string,
        action: AmendmentAction,
        body: string | undefined,
        mediaUrls?: string[],
    ): Promise<void> {
        if (busy || !sessionManager || !online) return;
        setBusy(true);
        try {
            const { recipientUserId, recipientPubKeyBytes } =
                await resolveRecipient(session, handle, isSaved);
            await sendAmendment(
                session.token,
                session.userId,
                session.deviceId,
                recipientUserId,
                recipientPubKeyBytes,
                session.sharingPublicKeyBytes,
                targetMsgId,
                action,
                body,
                sessionManager,
            );
            if (action === 'delete' && mediaUrls) {
                // Best-effort: the amendment alone satisfies user intent, so a
                // failed blob delete is logged, not surfaced. A future
                // orphan-media sweep (ADR-0006) catches anything left behind.
                for (const url of mediaUrls) {
                    storeDelete(session.token, url).catch((e) =>
                        console.error(
                            'media blob delete failed (best-effort):',
                            e,
                        ),
                    );
                }
            }
            await syncAndPublish(session, sessionManager);
        } catch (error) {
            console.error(`Failed to ${action} message:`, error);
            alert(`Failed to ${action} message. Please try again.`);
        } finally {
            setBusy(false);
        }
    }

    return {
        busy,
        editMessage: (msgId, newBody) => amend(msgId, 'edit', newBody),
        deleteMessage: (msgId, mediaUrls) =>
            amend(msgId, 'delete', undefined, mediaUrls),
    };
}
