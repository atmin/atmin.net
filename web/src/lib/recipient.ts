import { resolve } from './api';
import type { Session } from './auth';
import { base64UrlDecode } from './crypto';

export interface ResolvedRecipient {
    recipientUserId: string;
    recipientPubKeyBytes: Uint8Array;
}

// Resolve who a message (or amendment) is addressed to. Shared by the send and
// amendment paths so the saved-self shortcut and the not_found/released
// handling stay in one place. For `saved`, the recipient is the sender itself
// (multi-device self-copy); otherwise the handle is resolved live.
export async function resolveRecipient(
    session: Session,
    handle: string | undefined,
    isSaved: boolean,
): Promise<ResolvedRecipient> {
    if (isSaved) {
        return {
            recipientUserId: session.userId,
            recipientPubKeyBytes: session.sharingPublicKeyBytes,
        };
    }
    if (!handle) throw new Error('No recipient handle');
    const res = await resolve(handle);
    if (res.status === 'not_found') throw new Error('Recipient unknown');
    if (res.status === 'released') throw new Error('Recipient deleted');
    // res.status === 'live'
    return {
        recipientUserId: res.user_id,
        recipientPubKeyBytes: base64UrlDecode(res.sharing_public_key),
    };
}
