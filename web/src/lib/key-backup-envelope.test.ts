import { describe, expect, it } from 'vitest';
import {
    parseKeyBackupEnvelope,
    wrapKeyBackupEnvelope,
} from './key-backup-envelope';

const iv = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const ct = new Uint8Array([13, 14, 15, 16, 17, 18, 19, 20]);

describe('key-backup envelope', () => {
    it('wrap → parse round-trips bytes and version', () => {
        const env = wrapKeyBackupEnvelope(2, iv, ct, 'session-abc');
        const parsed = parseKeyBackupEnvelope(env);
        expect(parsed.v).toBe(2);
        expect(parsed.iv).toEqual(iv);
        expect(parsed.ciphertext).toEqual(ct);
        expect(parsed.sessionId).toBe('session-abc');
    });

    it('wrap mirrors session_id into msg_id for compaction dedup', () => {
        const env = wrapKeyBackupEnvelope(2, iv, ct, 'session-abc');
        expect(env.session_id).toBe('session-abc');
        expect(env.msg_id).toBe('session-abc');
    });

    it('wrap without sessionId omits session_id/msg_id (contacts.json)', () => {
        const env = wrapKeyBackupEnvelope(3, iv, ct);
        expect(env.session_id).toBeUndefined();
        expect(env.msg_id).toBeUndefined();
        expect(env.v).toBe(3);
    });

    it('parse defensively reads a {iv, ciphertext} shape with no v as v: 1', () => {
        const legacy = {
            iv: btoa(String.fromCharCode(...iv)),
            ciphertext: btoa(String.fromCharCode(...ct)),
        };
        const parsed = parseKeyBackupEnvelope(legacy);
        expect(parsed.v).toBe(1);
        expect(parsed.iv).toEqual(iv);
        expect(parsed.ciphertext).toEqual(ct);
        expect(parsed.sessionId).toBeUndefined();
    });

    it('parse throws on missing iv', () => {
        expect(() => parseKeyBackupEnvelope({ ciphertext: 'abc' })).toThrow(
            /iv/,
        );
    });

    it('parse throws on missing ciphertext', () => {
        expect(() => parseKeyBackupEnvelope({ iv: 'abc' })).toThrow(
            /ciphertext/,
        );
    });

    it('parse throws on non-object input', () => {
        expect(() => parseKeyBackupEnvelope('hello')).toThrow();
        expect(() => parseKeyBackupEnvelope(null)).toThrow();
    });

    it('parse coerces non-positive v to 1 (defensive)', () => {
        const env = {
            v: 0,
            iv: btoa(String.fromCharCode(...iv)),
            ciphertext: btoa(String.fromCharCode(...ct)),
        };
        expect(parseKeyBackupEnvelope(env).v).toBe(1);
    });
});
