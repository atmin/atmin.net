import { describe, expect, it } from 'vitest';
import {
    FileTooLargeError,
    MAX_MEDIA_BYTES,
    MediaCorruptError,
    decryptMedia,
    encryptMedia,
    sanitizeDownloadFilename,
    sniffInlineImageMime,
} from './media.js';

function makeFile(bytes: Uint8Array, name = 'test.bin'): File {
    return new File([bytes], name, { type: 'application/octet-stream' });
}

describe('encryptMedia / decryptMedia', () => {
    it('round-trips bytes', async () => {
        const plaintext = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
        const enc = await encryptMedia(makeFile(plaintext));
        expect(enc.ciphertext.length).toBe(plaintext.length + 16);
        expect(enc.key.length).toBe(32);
        expect(enc.iv.length).toBe(12);
        expect(enc.plaintextSize).toBe(plaintext.length);

        const decrypted = await decryptMedia(enc.ciphertext, enc.key, enc.iv);
        expect(new Uint8Array(decrypted)).toEqual(plaintext);
    });

    it('throws MediaCorruptError on flipped ciphertext byte', async () => {
        const enc = await encryptMedia(makeFile(new Uint8Array([1, 2, 3])));
        const tampered = new Uint8Array(enc.ciphertext);
        tampered[0] ^= 0x01;
        await expect(decryptMedia(tampered, enc.key, enc.iv)).rejects.toThrow(
            MediaCorruptError,
        );
    });

    it('throws MediaCorruptError on flipped IV byte', async () => {
        const enc = await encryptMedia(makeFile(new Uint8Array([1, 2, 3])));
        const badIv = new Uint8Array(enc.iv);
        badIv[0] ^= 0x01;
        await expect(
            decryptMedia(enc.ciphertext, enc.key, badIv),
        ).rejects.toThrow(MediaCorruptError);
    });

    it('throws MediaCorruptError with the wrong key', async () => {
        const enc = await encryptMedia(makeFile(new Uint8Array([1, 2, 3])));
        const wrongKey = crypto.getRandomValues(new Uint8Array(32));
        await expect(
            decryptMedia(enc.ciphertext, wrongKey, enc.iv),
        ).rejects.toThrow(MediaCorruptError);
    });

    it('throws FileTooLargeError before touching crypto.subtle', async () => {
        // Build a File without allocating MAX+1 bytes: use a Blob of empty parts
        // then claim size via a Proxy-like File. Simplest: allocate a small
        // buffer but create a File whose size getter lies. That's fragile — use
        // a real small overflow instead by mocking the size check.
        // Real approach: construct a Blob of MAX+1 zero bytes (slow but correct
        // on modern engines).
        const tooBig = new Uint8Array(MAX_MEDIA_BYTES + 1);
        const file = makeFile(tooBig);
        // Guard against spending crypto cycles: patch subtle.encrypt to throw.
        const original = crypto.subtle.encrypt;
        (crypto.subtle as unknown as { encrypt: unknown }).encrypt = () => {
            throw new Error('should not reach crypto.subtle');
        };
        try {
            await expect(encryptMedia(file)).rejects.toThrow(FileTooLargeError);
        } finally {
            (crypto.subtle as unknown as { encrypt: unknown }).encrypt =
                original;
        }
    });
});

describe('sniffInlineImageMime', () => {
    const pad = (prefix: number[]): Uint8Array => {
        const out = new Uint8Array(16);
        out.set(prefix);
        return out;
    };

    it('detects PNG', () => {
        expect(
            sniffInlineImageMime(
                pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            ),
        ).toBe('image/png');
    });
    it('detects JPEG', () => {
        expect(sniffInlineImageMime(pad([0xff, 0xd8, 0xff]))).toBe('image/jpeg');
    });
    it('detects GIF87a', () => {
        expect(
            sniffInlineImageMime(
                pad([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]),
            ),
        ).toBe('image/gif');
    });
    it('detects GIF89a', () => {
        expect(
            sniffInlineImageMime(
                pad([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]),
            ),
        ).toBe('image/gif');
    });
    it('detects WebP', () => {
        const b = new Uint8Array(16);
        b.set([0x52, 0x49, 0x46, 0x46], 0);
        b.set([0x57, 0x45, 0x42, 0x50], 8);
        expect(sniffInlineImageMime(b)).toBe('image/webp');
    });
    it('rejects SVG', () => {
        expect(
            sniffInlineImageMime(new TextEncoder().encode('<?xml version')),
        ).toBeNull();
        expect(sniffInlineImageMime(new TextEncoder().encode('<svg xmlns'))).toBeNull();
    });
    it('rejects PDF', () => {
        expect(sniffInlineImageMime(new TextEncoder().encode('%PDF-1.4\n\n\n\n'))).toBeNull();
    });
    it('rejects MP4 (ftyp)', () => {
        const b = new Uint8Array(16);
        b.set(new TextEncoder().encode('    ftypmp42'), 0);
        expect(sniffInlineImageMime(b)).toBeNull();
    });
    it('rejects plain text', () => {
        expect(sniffInlineImageMime(new TextEncoder().encode('hello world!'))).toBeNull();
    });
    it('rejects all-zero bytes', () => {
        expect(sniffInlineImageMime(new Uint8Array(16))).toBeNull();
    });
    it('returns null for input shorter than 12 bytes', () => {
        expect(sniffInlineImageMime(new Uint8Array(5))).toBeNull();
    });
});

describe('sanitizeDownloadFilename', () => {
    it('strips path separators', () => {
        expect(sanitizeDownloadFilename('../foo/bar\\baz.txt')).toBe(
            'foobarbaz.txt',
        );
    });
    it('strips NUL and control chars', () => {
        expect(
            sanitizeDownloadFilename('a\x00b\x01c\x1fd\x7fe\r\n\tf.txt'),
        ).toBe('abcdef.txt');
    });
    it('strips leading dots', () => {
        expect(sanitizeDownloadFilename('...hidden.txt')).toBe('hidden.txt');
    });
    it('returns "download" for empty input', () => {
        expect(sanitizeDownloadFilename('')).toBe('download');
        expect(sanitizeDownloadFilename('///')).toBe('download');
        expect(sanitizeDownloadFilename('.....')).toBe('download');
    });
    it('truncates long names to 255 bytes', () => {
        const long = 'a'.repeat(300) + '.txt';
        const out = sanitizeDownloadFilename(long);
        expect(new TextEncoder().encode(out).length).toBeLessThanOrEqual(255);
    });
});
