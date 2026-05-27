/**
 * Credential autodetection shared by login (add-device) and
 * device-revoke re-auth.
 *
 * A credential is either a legacy 12-word BIP39 mnemonic (decoded
 * directly to 16 bytes) or a v2 password (stretched through Argon2id
 * with the account's stored salt + params). Both paths converge on the
 * same 16-byte secret that feeds the HKDF chain in crypto.ts.
 */

import { mnemonicToEntropy, validateMnemonic } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';
import { argonStretch } from './argon2-worker.client';
import { base64UrlDecode, type KdfParams } from './crypto';

/**
 * A legacy credential is exactly 12 whitespace-separated wordlist tokens
 * with a valid checksum. The checksum gate matters: 12 valid words with
 * a broken checksum (one mistyped word) fall through to the password
 * path rather than throwing a confusing decoder error.
 */
export function isLegacyMnemonic(input: string): boolean {
    const normalized = input.trim().replace(/\s+/g, ' ');
    const tokens = normalized.split(' ');
    if (tokens.length !== 12) return false;
    if (!tokens.every((t) => wordlist.includes(t))) return false;
    return validateMnemonic(normalized, wordlist);
}

/** The account's v2 Argon2id params (absent for legacy v1 accounts). */
export interface CredentialParams {
    salt?: string;
    kdf?: KdfParams;
}

/**
 * Derive the 16-byte secret from a credential string, autodetecting
 * legacy mnemonic vs v2 password. The v2 path needs the account's
 * salt + kdf (from resolve, or the caller's own profile.json); a
 * non-mnemonic credential without v2 params means the account is
 * legacy and the user must supply their recovery phrase.
 */
export async function deriveSecretFromCredential(
    secretInput: string,
    params: CredentialParams,
): Promise<Uint8Array> {
    if (isLegacyMnemonic(secretInput)) {
        return new Uint8Array(mnemonicToEntropy(secretInput.trim(), wordlist));
    }
    if (!params.salt || !params.kdf) {
        throw new Error('Recovery phrase required for legacy account.');
    }
    return argonStretch(secretInput, base64UrlDecode(params.salt), params.kdf);
}
