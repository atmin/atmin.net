import { describe, expect, it } from 'vitest';
import { derive_secret } from '../../crypto/pkg-node/atmin_crypto.js';

// Integration test against the real WASM module (not a mock): a broken
// wasm-bindgen binding — wrong algorithm, wrong byte order, wrong hash
// length — would pass the mocked-worker test below but fail here. The
// expected value was captured once from this binding over a fixed
// (password, salt, params) tuple and is asserted as a regression guard.
describe('Argon2id WASM binding', () => {
    const password = new TextEncoder().encode('correct horse battery staple');
    const salt = new Uint8Array(16).fill(7);

    const hex = (b: Uint8Array) =>
        Array.from(b)
            .map((x) => x.toString(16).padStart(2, '0'))
            .join('');

    it('derives the expected 16 bytes for a known vector (m=8,t=1,p=1)', () => {
        const out = derive_secret(password, salt, 8, 1, 1);
        expect(out).toHaveLength(16);
        expect(hex(out)).toBe('5ab92eb2d281c62398f48c651db98830');
    });

    it('is deterministic for the same inputs', () => {
        const a = derive_secret(password, salt, 8, 1, 1);
        const b = derive_secret(password, salt, 8, 1, 1);
        expect(hex(a)).toBe(hex(b));
    });

    it('is salt-sensitive', () => {
        const other = new Uint8Array(16).fill(8);
        expect(hex(derive_secret(password, salt, 8, 1, 1))).not.toBe(
            hex(derive_secret(password, other, 8, 1, 1)),
        );
    });

    it('throws on a salt that is not 16 bytes', () => {
        expect(() =>
            derive_secret(password, new Uint8Array(15), 8, 1, 1),
        ).toThrow();
    });
});
