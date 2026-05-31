// Inner-plaintext parsing for the chat materializer.
//
// Kept dependency-free (a leaf module) so both the materializer (hooks/useChat)
// and the storage-summary logic (lib/db) can import it without creating an
// import cycle through messaging.ts (which itself imports db.ts).
//
// The wire format is a self-describing JSON object discriminated by `type`
// (see docs/specs/mvp-v0.1.md "Payload by content type" and ADR-0014). For
// backward compatibility this parser also accepts a legacy bare string (the
// pre-typed-envelope text format) and treats it as a text body.

export interface ParsedMediaFile {
    url: string;
    key: string;
    iv: string;
    name: string;
    size: number;
}

export type ParsedInner =
    | { kind: 'text'; body: string }
    | { kind: 'media'; body: string; file: ParsedMediaFile }
    | { kind: 'amendment'; targetMsgId: string; action: string; body?: string }
    | { kind: 'unknown' };

export function parseInner(text: string): ParsedInner {
    // Legacy / pre-typed-envelope plaintext: a bare string, not JSON.
    if (!text.startsWith('{')) return { kind: 'text', body: text };

    let obj: unknown;
    try {
        obj = JSON.parse(text);
    } catch {
        return { kind: 'text', body: text };
    }
    if (!obj || typeof obj !== 'object') return { kind: 'text', body: text };
    const o = obj as Record<string, unknown>;

    if (o.type === 'text' && typeof o.body === 'string') {
        return { kind: 'text', body: o.body };
    }

    if (
        o.type === 'media' &&
        typeof o.body === 'string' &&
        o.file &&
        typeof o.file === 'object'
    ) {
        const f = o.file as Record<string, unknown>;
        if (
            typeof f.url === 'string' &&
            typeof f.key === 'string' &&
            typeof f.iv === 'string' &&
            typeof f.name === 'string' &&
            typeof f.size === 'number'
        ) {
            return {
                kind: 'media',
                body: o.body,
                file: {
                    url: f.url,
                    key: f.key,
                    iv: f.iv,
                    name: f.name,
                    size: f.size,
                },
            };
        }
    }

    // Recognized as an amendment by `type` + `target_msg_id`. The `action` is
    // carried through verbatim (even an unrecognized one) so the materializer
    // can drop an unknown-action amendment without it leaking back into the
    // chat as a stray text bubble.
    if (o.type === 'amendment' && typeof o.target_msg_id === 'string') {
        return {
            kind: 'amendment',
            targetMsgId: o.target_msg_id,
            action: typeof o.action === 'string' ? o.action : '',
            ...(typeof o.body === 'string' ? { body: o.body } : {}),
        };
    }

    // Unknown / future top-level type. Dropped from materialization
    // (ADR-0014: better to miss a feature than render garbage). Distinct from
    // a legacy bare string, which is handled as text at the top.
    return { kind: 'unknown' };
}

// True when the plaintext is an amendment envelope. Used by the storage layer
// to exclude amendments from conversation-summary previews/counts (an edit or
// delete must not bump a conversation to the top of the chat list).
export function isAmendment(text: string): boolean {
    return parseInner(text).kind === 'amendment';
}
