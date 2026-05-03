interface EnvelopeBase {
    v: 1;
    to_user: string;
    from_user: string;
    from_device: string;
    msg_id: string;
    sent_at?: string;
}

export interface KeySharePayload {
    conversation_id?: string;
    ephemeral_key: string;
    iv: string;
    ciphertext: string;
}

export interface MessagePayload {
    conversation_id?: string;
    session_id: string;
    ciphertext: string;
}

export interface KeyShareEnvelope extends EnvelopeBase {
    content_type: 'megolm.key_share';
    payload: KeySharePayload;
}

export interface MessageEnvelope extends EnvelopeBase {
    content_type: 'megolm.message';
    payload: MessagePayload;
}

export type Envelope = KeyShareEnvelope | MessageEnvelope;
