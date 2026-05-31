import { describe, expect, it } from 'vitest';
import { formatBytes } from './utils';

describe('formatBytes', () => {
    const cases: Array<[number, string]> = [
        [0, '0 B'],
        [1023, '1023 B'],
        [1024, '1 KB'],
        [500 * 1024, '500 KB'],
        [1024 * 1024, '1.0 MB'],
        [12 * 1024 * 1024, '12 MB'],
        [1 << 30, '1.00 GB'],
        [12 * (1 << 30), '12.0 GB'],
    ];

    for (const [input, expected] of cases) {
        it(`formats ${input} as ${expected}`, () => {
            expect(formatBytes(input)).toBe(expected);
        });
    }
});
