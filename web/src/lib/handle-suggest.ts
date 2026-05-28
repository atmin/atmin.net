import { wordlist } from '@scure/bip39/wordlists/english.js';

/**
 * Generate a memorable two-word handle. Same shape as the legacy
 * server-side BIP39 auto-generation, just on the client now (ADR-0013).
 * Wordlist is already bundled for the legacy mnemonic autodetect path,
 * so this adds no new dependency weight.
 */
export function suggestHandle(): string {
    const i = crypto.getRandomValues(new Uint16Array(2));
    return `${wordlist[i[0] % 2048]}-${wordlist[i[1] % 2048]}`;
}

// Mirrors the server-side regex in server/handle.go. Keeping the two in
// sync is a deliberate duplication: the client uses this for instant
// feedback while typing, the server uses its copy as the authoritative
// gate. A handle test on both sides pins each definition.
const HANDLE_REGEX = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;

/**
 * Client-side handle validation: charset / length / no consecutive
 * hyphens. Returns null when the handle is syntactically valid, or a
 * short user-facing error message when it isn't. Reserved-list checks
 * are server-only (the embedded list is the authoritative copy).
 */
export function validateHandleShape(handle: string): string | null {
    if (!HANDLE_REGEX.test(handle)) {
        return 'Handle must be 3–32 lowercase letters, digits, or hyphens, starting with a letter.';
    }
    if (handle.includes('--')) {
        return 'Handle cannot contain consecutive hyphens.';
    }
    return null;
}
