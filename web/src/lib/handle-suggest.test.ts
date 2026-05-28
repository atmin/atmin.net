import { describe, expect, it } from 'vitest';
import { suggestHandle, validateHandleShape } from './handle-suggest';

describe('suggestHandle', () => {
    it('produces a regex-valid two-word handle on every call (sample N=200)', () => {
        for (let i = 0; i < 200; i++) {
            const h = suggestHandle();
            expect(h).toMatch(/^[a-z]+-[a-z]+$/);
            expect(validateHandleShape(h)).toBeNull();
        }
    });
});

describe('validateHandleShape', () => {
    it('accepts canonical examples', () => {
        for (const h of [
            'alice',
            'alice-test',
            'copper-falcon',
            'abc',
            'a-b',
            'alice2',
            'alice-2024',
            'abcdefghij1234567890123456789012', // 32 chars
        ]) {
            expect(validateHandleShape(h)).toBeNull();
        }
    });

    it('rejects on shape', () => {
        for (const h of [
            'ab', // too short
            '', // empty
            'Alice', // uppercase
            'al ice', // space
            'alice_test', // underscore
            '-alice', // leading hyphen
            'alice-', // trailing hyphen
            '1alice', // starts with digit
            'abcdefghij1234567890123456789012x', // 33 chars
        ]) {
            expect(validateHandleShape(h)).not.toBeNull();
        }
    });

    it('rejects consecutive hyphens with a distinct message', () => {
        const msg = validateHandleShape('alice--bot');
        expect(msg).not.toBeNull();
        expect(msg?.toLowerCase()).toContain('consecutive');
    });
});
