/**
 * Client-side AES-256-GCM media encryption for v0.1.
 *
 * Each file gets a fresh random 32-byte key + 12-byte IV. The ciphertext
 * carries the 16-byte GCM auth tag, which is the sole integrity check: no
 * SHA-256 or MIME travels in the Megolm envelope. Oversize files throw
 * `FileTooLargeError` before touching `crypto.subtle`.
 */

export const MAX_MEDIA_BYTES = 25 * 1024 * 1024;

type Bytes = Uint8Array<ArrayBuffer>;
const buf = (data: Uint8Array): Bytes => data as Bytes; // keep in sync with server/media_quota.go

export class FileTooLargeError extends Error {
    constructor() {
        super('file exceeds MAX_MEDIA_BYTES');
        this.name = 'FileTooLargeError';
    }
}

export class MediaCorruptError extends Error {
    constructor() {
        super('media decryption failed (tampered ciphertext, IV, or key)');
        this.name = 'MediaCorruptError';
    }
}

export interface EncryptedMedia {
    ciphertext: Uint8Array; // plaintext.length + 16 (GCM tag)
    key: Uint8Array; // 32 bytes
    iv: Uint8Array; // 12 bytes
    plaintextSize: number;
}

export async function encryptMedia(file: File): Promise<EncryptedMedia> {
    if (file.size > MAX_MEDIA_BYTES) throw new FileTooLargeError();

    const key = crypto.getRandomValues(new Uint8Array(32));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new Uint8Array(await file.arrayBuffer());

    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        buf(key),
        { name: 'AES-GCM' },
        false,
        ['encrypt'],
    );
    const ctBuf = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv: buf(iv) },
        cryptoKey,
        buf(plaintext),
    );

    return {
        ciphertext: new Uint8Array(ctBuf),
        key,
        iv,
        plaintextSize: file.size,
    };
}

export async function decryptMedia(
    ciphertext: Uint8Array,
    key: Uint8Array,
    iv: Uint8Array,
): Promise<Uint8Array> {
    const cryptoKey = await crypto.subtle.importKey(
        'raw',
        buf(key),
        { name: 'AES-GCM' },
        false,
        ['decrypt'],
    );
    try {
        const out = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: buf(iv) },
            cryptoKey,
            buf(ciphertext),
        );
        return new Uint8Array(out);
    } catch {
        throw new MediaCorruptError();
    }
}

export type InlineMime =
    | 'image/png'
    | 'image/jpeg'
    | 'image/gif'
    | 'image/webp';

/** Returns the inline MIME type if the first bytes match a v0.1 image format, else null. */
export function sniffInlineImageMime(
    plaintext: Uint8Array,
): InlineMime | null {
    if (plaintext.length < 12) return null;
    const b = plaintext;

    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (
        b[0] === 0x89 &&
        b[1] === 0x50 &&
        b[2] === 0x4e &&
        b[3] === 0x47 &&
        b[4] === 0x0d &&
        b[5] === 0x0a &&
        b[6] === 0x1a &&
        b[7] === 0x0a
    )
        return 'image/png';

    // JPEG: FF D8 FF
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';

    // GIF: 47 49 46 38 (37|39) 61
    if (
        b[0] === 0x47 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x38 &&
        (b[4] === 0x37 || b[4] === 0x39) &&
        b[5] === 0x61
    )
        return 'image/gif';

    // WebP: 52 49 46 46 ?? ?? ?? ?? 57 45 42 50
    if (
        b[0] === 0x52 &&
        b[1] === 0x49 &&
        b[2] === 0x46 &&
        b[3] === 0x46 &&
        b[8] === 0x57 &&
        b[9] === 0x45 &&
        b[10] === 0x42 &&
        b[11] === 0x50
    )
        return 'image/webp';

    return null;
}

/**
 * Strips path separators, NUL, control chars, leading dots; truncates to 255
 * bytes; falls back to "download" on empty input.
 */
export function sanitizeDownloadFilename(name: string): string {
    // Drop path separators entirely (no collapse to "_"), strip control chars.
    let s = '';
    for (const ch of name) {
        const code = ch.charCodeAt(0);
        if (ch === '/' || ch === '\\') continue;
        if (code === 0) continue;
        if (code < 0x20 || code === 0x7f) continue;
        s += ch;
    }
    // Strip leading dots (no hidden files, no "..").
    s = s.replace(/^\.+/, '');
    s = s.trim();
    if (s === '') return 'download';

    // Truncate to 255 bytes (UTF-8).
    const encoder = new TextEncoder();
    const bytes = encoder.encode(s);
    if (bytes.length <= 255) return s;
    // Decode the first 255 bytes, stopping at the last complete code point.
    const decoder = new TextDecoder('utf-8', { fatal: false });
    return decoder.decode(bytes.slice(0, 255)).replace(/\uFFFD+$/, '');
}
