/**
 * Versioned envelope for client-encrypted backup blobs (key backups and
 * contacts.json). See ADR-0012 — Backup migration. The outer `v` field
 * identifies which `key_version`'s backup key encrypted the ciphertext.
 *
 * - Key-backup blobs (`keys/{uid}/live/{session_id}`) also carry
 *   `session_id` so the chain-aware reader can dispatch per entry, and
 *   `msg_id` (= session_id) which the server's compaction uses for
 *   per-archive dedup.
 * - `contacts.json` reuses the same envelope sans `session_id`.
 *
 * Every envelope written now carries `v`. The pre-ADR-0012 shape
 * (`{iv, ciphertext}` with no `v`) has no current producer, but the
 * reader still defensively treats a missing `v` as `v: 1`: backup blobs
 * are durable and write-once (rotation/compaction never rewrite them),
 * so a stray pre-versioning blob must stay readable rather than be
 * silently dropped on restore and lose that session's history.
 */
export interface KeyBackupEnvelopeV2 {
    v: number;
    iv: string; // base64
    ciphertext: string; // base64
    session_id?: string;
    msg_id?: string;
}

export interface ParsedEnvelope {
    v: number;
    iv: Uint8Array;
    ciphertext: Uint8Array;
    sessionId?: string;
}

function bytesToB64(b: Uint8Array): string {
    return btoa(String.fromCharCode(...b));
}

function b64ToBytes(s: string): Uint8Array {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

/**
 * Build the wire shape. If `sessionId` is provided (key-backup case),
 * the envelope also gets `msg_id` mirrored from it for server-side
 * compaction dedup.
 */
export function wrapKeyBackupEnvelope(
    v: number,
    iv: Uint8Array,
    ciphertext: Uint8Array,
    sessionId?: string,
): KeyBackupEnvelopeV2 {
    const env: KeyBackupEnvelopeV2 = {
        v,
        iv: bytesToB64(iv),
        ciphertext: bytesToB64(ciphertext),
    };
    if (sessionId) {
        env.session_id = sessionId;
        env.msg_id = sessionId;
    }
    return env;
}

/**
 * Parse the `{v, iv, ciphertext, ...}` wire shape. Throws on missing
 * iv/ciphertext. A missing or non-positive `v` is defensively coerced to
 * `v: 1` (see the type doc above) so a stray pre-versioning blob stays
 * readable.
 */
export function parseKeyBackupEnvelope(raw: unknown): ParsedEnvelope {
    if (!raw || typeof raw !== 'object') {
        throw new Error('envelope: not an object');
    }
    const obj = raw as Record<string, unknown>;
    if (typeof obj.iv !== 'string' || typeof obj.ciphertext !== 'string') {
        throw new Error('envelope: missing iv or ciphertext');
    }
    const v = typeof obj.v === 'number' && obj.v > 0 ? obj.v : 1;
    const sessionId =
        typeof obj.session_id === 'string' ? obj.session_id : undefined;
    return {
        v,
        iv: b64ToBytes(obj.iv),
        ciphertext: b64ToBytes(obj.ciphertext),
        sessionId,
    };
}
