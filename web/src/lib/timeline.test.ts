import { describe, expect, it } from 'vitest';
import { dayKey, dayLabel } from './timeline';

// Dates are built with the local-time constructor `new Date(y, m, d, …)` (not a
// string, which parses as UTC) so every assertion is stable regardless of the
// runner's timezone — the helper reads local getters, and so do these fixtures.

describe('dayKey', () => {
    it('formats the local calendar day as YYYY-MM-DD', () => {
        expect(dayKey(new Date(2025, 5, 14, 9, 30))).toBe('2025-06-14');
        expect(dayKey(new Date(2025, 0, 1, 0, 0))).toBe('2025-01-01');
        expect(dayKey(new Date(2025, 11, 31, 23, 59))).toBe('2025-12-31');
    });

    it('groups two times on the same local day under one key', () => {
        const morning = new Date(2025, 5, 14, 0, 1);
        const night = new Date(2025, 5, 14, 23, 59);
        expect(dayKey(morning)).toBe(dayKey(night));
    });
});

describe('dayLabel', () => {
    const now = new Date(2026, 5, 21, 14, 0); // 21 June 2026, local

    it('labels the current day "Today"', () => {
        expect(dayLabel(new Date(2026, 5, 21, 8, 0), now)).toBe('Today');
        expect(dayLabel(new Date(2026, 5, 21, 23, 59), now)).toBe('Today');
    });

    it('labels the previous day "Yesterday"', () => {
        expect(dayLabel(new Date(2026, 5, 20, 22, 0), now)).toBe('Yesterday');
    });

    it('labels an earlier day this year "D MMMM"', () => {
        expect(dayLabel(new Date(2026, 5, 14, 10, 0), now)).toBe('14 June');
        expect(dayLabel(new Date(2026, 0, 3, 10, 0), now)).toBe('3 January');
    });

    it('labels a day in an earlier year "D MMMM YYYY"', () => {
        expect(dayLabel(new Date(2025, 5, 14, 10, 0), now)).toBe(
            '14 June 2025',
        );
    });

    // The "Yesterday" computation must normalise month/year rollover — the
    // local-time Date constructor does this (date 0 → last day of prev month).
    it('treats the last day of last month as "Yesterday" on the 1st', () => {
        const firstOfMonth = new Date(2026, 6, 1, 9, 0); // 1 July 2026
        expect(dayLabel(new Date(2026, 5, 30, 20, 0), firstOfMonth)).toBe(
            'Yesterday',
        );
    });

    it('treats 31 Dec as "Yesterday" on 1 Jan across a year boundary', () => {
        const newYear = new Date(2026, 0, 1, 0, 30); // 1 Jan 2026
        expect(dayLabel(new Date(2025, 11, 31, 23, 30), newYear)).toBe(
            'Yesterday',
        );
    });
});
