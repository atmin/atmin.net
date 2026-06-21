// Calendar-day grouping for the chat timeline. All boundaries are viewer-local:
// two messages share a day iff they fall on the same local calendar date, and a
// label like "Yesterday" is relative to the viewer's clock — never UTC.

const MONTHS = [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
];

// Local calendar-day key, `YYYY-MM-DD`. Two timestamps group under the same
// day-divider iff their keys match. Built from local getters (not toISOString,
// which is UTC) so the boundary is midnight in the viewer's zone.
export function dayKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

// The divider label for the day `d` falls on, relative to `now`:
//   today      → "Today"
//   yesterday  → "Yesterday"
//   this year  → "14 June"
//   older      → "14 June 2025"
// "Yesterday" is `now`'s local date minus one day; the local-time Date
// constructor normalises month/year rollover (and is DST-safe — we compare day
// keys, never absolute durations).
export function dayLabel(d: Date, now: Date): string {
    const key = dayKey(d);
    if (key === dayKey(now)) return 'Today';
    const yesterday = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() - 1,
    );
    if (key === dayKey(yesterday)) return 'Yesterday';
    const label = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
    return d.getFullYear() === now.getFullYear()
        ? label
        : `${label} ${d.getFullYear()}`;
}
