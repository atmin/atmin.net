/**
 * Password-credential derivation shared by login (add-device), device-revoke
 * re-auth, and rotation.
 *
 * Every account is password-derived: the credential is stretched through
 * Argon2id with the account's stored salt + params, producing the 16-byte
 * secret that feeds the HKDF chain in crypto.ts. (Accounts predating the
 * password flow used a 12-word BIP39 mnemonic; that path was removed once
 * every account had migrated — see ADR-0011.)
 */

import { argonStretch } from './argon2-worker.client';
import { base64UrlDecode, type KdfParams } from './crypto';

/** The account's Argon2id params, read from resolve or the caller's profile. */
export interface CredentialParams {
    salt?: string;
    kdf?: KdfParams;
}

/**
 * Derive the 16-byte secret from a password and the account's stored salt +
 * kdf. The params come from resolve (login) or the caller's own profile.json
 * (revoke / rotate); a live account always carries them, so an absent pair is
 * a corrupt-account error rather than a fork in the flow.
 */
export async function deriveSecretFromPassword(
    password: string,
    params: CredentialParams,
): Promise<Uint8Array> {
    if (!params.salt || !params.kdf) {
        throw new Error('Account is missing credential parameters.');
    }
    return argonStretch(password, base64UrlDecode(params.salt), params.kdf);
}
