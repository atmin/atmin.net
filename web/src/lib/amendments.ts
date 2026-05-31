import type { SessionManager } from './megolm-session';
import {
    type AmendmentAction,
    type AmendmentPayload,
    sendInnerPayload,
} from './messaging';

// Send an amendment (edit/delete) referencing a prior message by its msg_id.
//
// An amendment is a regular `megolm.message` envelope whose inner plaintext is
// `{type: 'amendment', target_msg_id, action, body?}` — `target_msg_id` lives
// inside the encrypted plaintext so the server never learns which message is
// being amended (ADR-0014). It reuses sendInnerPayload, so session rotation,
// key-share, and the self-copy for the sender's other devices are handled
// identically to a normal message. `body` is included iff action === 'edit'.
export function sendAmendment(
    token: string,
    fromUserId: string,
    fromDeviceId: string,
    toUserId: string,
    toPublicKeyBytes: Uint8Array,
    selfPublicKeyBytes: Uint8Array,
    targetMsgId: string,
    action: AmendmentAction,
    body: string | undefined,
    sessionManager: SessionManager,
): Promise<void> {
    const payload: AmendmentPayload = {
        type: 'amendment',
        target_msg_id: targetMsgId,
        action,
        ...(action === 'edit' ? { body: body ?? '' } : {}),
    };
    return sendInnerPayload(
        token,
        fromUserId,
        fromDeviceId,
        toUserId,
        toPublicKeyBytes,
        selfPublicKeyBytes,
        payload,
        sessionManager,
    );
}
