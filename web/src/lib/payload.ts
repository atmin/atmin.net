// Inner-plaintext parsing for the chat materializer.
//
// Free of runtime dependencies (a leaf module) so both the materializer
// (hooks/useChat) and the storage-summary logic (lib/db) can import it without
// creating an import cycle through messaging.ts (which itself imports db.ts).
// The single import below is type-only (erased at build), so the property holds.
//
// The wire format is a self-describing JSON object discriminated by `type`
// (see docs/specs/mvp-v0.1.md "Payload by content type" and ADR-0014). For
// backward compatibility this parser also accepts a legacy bare string (the
// pre-typed-envelope text format) and treats it as a text body.

import type { MediaFileExtras } from './media';

// The canonical wire media-file shape: key/iv as base64url strings (vs the
// decoded bytes in lib/media's MediaFile). The five required fields stay the
// parse gate; the additive ADR-0022 fields ride along via MediaFileExtras and
// are read best-effort. Shared with the outbound MediaPayload (lib/messaging) —
// send and parse of the same JSON stay in lockstep by construction.
export interface ParsedMediaFile extends MediaFileExtras {
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
            const file: ParsedMediaFile = {
                url: f.url,
                key: f.key,
                iv: f.iv,
                name: f.name,
                size: f.size,
            };
            // Additive fields are best-effort: read each only when well-typed,
            // leave absent otherwise (a legacy `file` carries none).
            if (typeof f.mime === 'string') file.mime = f.mime;
            if (typeof f.width === 'number') file.width = f.width;
            if (typeof f.height === 'number') file.height = f.height;
            if (typeof f.optimized === 'boolean') file.optimized = f.optimized;
            return { kind: 'media', body: o.body, file };
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
