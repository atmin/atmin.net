// @vitest-environment happy-dom
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadScorer } from './password-strength';

function sha1Upper(pw: string): string {
    return createHash('sha1').update(pw).digest('hex').toUpperCase();
}

// A fetch stub that answers HIBP range queries. `match` controls whether
// the queried password's hash suffix appears in the returned range body.
function hibpFetch(opts: {
    status?: number;
    matchSuffixOf?: string;
    reject?: boolean;
}) {
    return vi.fn(async (input: string | URL) => {
        if (opts.reject) throw new Error('network down');
        const url = String(input);
        const range = url.split('/range/')[1] ?? '';
        let body = 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF:1\r\n';
        if (opts.matchSuffixOf) {
            const hash = sha1Upper(opts.matchSuffixOf);
            if (hash.slice(0, 5) === range) {
                body = `${hash.slice(5)}:4242\r\n${body}`;
            }
        }
        return {
            status: opts.status ?? 200,
            text: async () => body,
        } as unknown as Response;
    });
}

describe('password-strength scorer', () => {
    beforeEach(() => {
        // Default: HIBP reachable, no match — keeps bucket tests off the
        // pwned path unless they opt in.
        vi.stubGlobal('fetch', hibpFetch({}));
    });
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('scores an obviously weak password low', async () => {
        const score = await loadScorer();
        const result = await score('password');
        expect(result.score).toBeLessThanOrEqual(1);
    });

    it('scores a long mixed passphrase high', async () => {
        const score = await loadScorer();
        const result = await score('Tr0ub4dour&3xpl0re!Quokka-velvet');
        expect(result.score).toBeGreaterThanOrEqual(3);
        expect(result.pwned).toBe(false);
    });

    it('flags pwned: true when the HIBP range contains the hash suffix', async () => {
        vi.stubGlobal('fetch', hibpFetch({ matchSuffixOf: 'password' }));
        const score = await loadScorer();
        const result = await score('password');
        expect(result.pwned).toBe(true);
    });

    it('returns pwned: false on a 404 / no-match response', async () => {
        vi.stubGlobal('fetch', hibpFetch({ status: 404 }));
        const score = await loadScorer();
        const result = await score('correct-horse-battery-staple-9000');
        expect(result.pwned).toBe(false);
    });

    it('falls through without throwing when HIBP is unreachable (offline)', async () => {
        vi.stubGlobal('fetch', hibpFetch({ reject: true }));
        const score = await loadScorer();
        const result = await score('correct-horse-battery-staple-9000');
        expect(result.pwned).toBe(false);
        expect(typeof result.score).toBe('number');
    });
});
