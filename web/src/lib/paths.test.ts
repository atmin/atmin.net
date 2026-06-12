import { describe, expect, it } from 'vitest';
import { path } from './paths';

// I10 — a Megolm session_id is standard base64 (alphabet includes `/` and `+`).
// Interpolated raw into an S3 key it can form a leading/trailing/doubled `/`, an
// invalid object name (XMinioInvalidObjectName, 400) → the backup is silently
// lost. keyBackup must encode the sid base64url so the key is always a single,
// object-name-safe segment under `live/`.
// See docs/scenarios/invariants/i10-key-backup-object-name-safe.md.
describe('path.keyBackup — object-name-safe session_id (I10)', () => {
    // One non-empty base64url segment under live/: no `//`, no leading/trailing
    // slash, alphabet limited to base64url.
    const SAFE = /^keys\/[^/]+\/live\/[A-Za-z0-9_-]+$/;

    const adversarial = [
        'abc/def', // embedded slash
        '/abcdef', // leading slash (the exact trace shape: live//…)
        'abcdef/', // trailing slash
        'ab//cd', // doubled slash
        'a+b/c=', // plus, slash, base64 padding
        'Gx9/uX+TQy/UGmjbUvX8ZdDkAehP76VE/u7WXSVT5ET', // realistic 43-char b64
    ];

    for (const sid of adversarial) {
        it(`yields a valid object name for sid ${JSON.stringify(sid)}`, () => {
            const key = path.keyBackup('u1', sid);
            expect(key, key).toMatch(SAFE);
            expect(key.includes('//'), 'no doubled slash').toBe(false);
        });
    }

    it('encodes base64 → base64url deterministically (no `+`/`/`/`=`)', () => {
        expect(path.keyBackup('u1', 'a+b/c=')).toBe('keys/u1/live/a-b_c');
    });
});
