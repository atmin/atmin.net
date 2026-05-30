/**
 * Web Crypto utilities for atmin.net key management.
 *
 * - HKDF-SHA256 key derivation from backup secret
 * - Ed25519 auth proofs (sign/verify)
 * - ECIES key share encryption (ECDH P-256 + HKDF + AES-256-GCM)
 * - AES-256-GCM key backup encryption
 *
 * The sharing private key is stored as a non-extractable CryptoKey: XSS can
 * use it but cannot export the bytes. See ADR-0008.
 *
 * @noble/curves is used only to derive the P-256 public point from a
 * deterministic seed scalar, because Web Crypto requires JWK with x,y,d on
 * ECDH import and cannot compute the public point itself.
 */

import { p256 } from '@noble/curves/nist.js';
import canonicalize from 'canonicalize';

const enc = new TextEncoder();

// TS 5.9 made Uint8Array generic over ArrayBufferLike; Web Crypto DOM types
// expect BufferSource backed by ArrayBuffer. Our Uint8Arrays always use
// regular ArrayBuffer, so this cast is safe.
type Bytes = Uint8Array<ArrayBuffer>;
const buf = (data: Uint8Array): Bytes => data as Bytes;

// ── PKCS8 prefixes (ASN.1 DER) ─────────────────────────────────────

const ED25519_PKCS8_PREFIX: Bytes = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70,
    0x04, 0x22, 0x04, 0x20,
]) as Bytes;

function wrapPkcs8(prefix: Bytes, seed: Bytes): Bytes {
    const out = new Uint8Array(prefix.length + seed.length) as Bytes;
    out.set(prefix);
    out.set(seed, prefix.length);
    return out;
}

export function base64UrlEncode(bytes: Uint8Array): string {
    return btoa(String.fromCharCode(...bytes))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

export function base64UrlDecode(s: string): Uint8Array {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    return Uint8Array.from(atob(b64 + pad), (c) => c.charCodeAt(0));
}

// ── Backup secret ───────────────────────────────────────────────────

export function generateBackupSecret(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(16));
}

// ── Argon2id credential stretching (v2) ─────────────────────────────
//
// v2 accounts stretch a user-typed password through Argon2id into the
// 16-byte secret that feeds the HKDF chain below. The params are
// per-account and stored on profile.json; DEFAULT_KDF is the floor for
// new accounts (ADR-0011). The stretch itself runs in a Web Worker —
// see argon2-worker.client.ts. deriveKeys is unchanged: it still takes
// 16 bytes and runs HKDF, so the Argon2id stage composes one level up.

export interface KdfParams {
    type: 'argon2id';
    m: number; // memory cost, KiB
    t: number; // iterations
    p: number; // parallelism
}

// Floor for new accounts; the server enforces the same minimum (ADR-0016).
export const DEFAULT_KDF: KdfParams = {
    type: 'argon2id',
    m: 65536,
    t: 3,
    p: 1,
};

export function generateSalt(): Uint8Array {
    return crypto.getRandomValues(new Uint8Array(16));
}

// ── HKDF key derivation ─────────────────────────────────────────────

const HKDF_SALT = enc.encode('atmin.net');

async function hkdfDerive(
    secret: Uint8Array,
    info: string,
): Promise<ArrayBuffer> {
    const key = await crypto.subtle.importKey(
        'raw',
        buf(secret),
        'HKDF',
        false,
        ['deriveBits'],
    );
    return crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: HKDF_SALT,
            info: enc.encode(info),
        },
        key,
        256,
    );
}

export interface DerivedKeys {
    auth: {
        privateKey: CryptoKey;
        publicKey: CryptoKey;
        publicKeyBytes: Uint8Array;
    };
    sharing: {
        privateKey: CryptoKey;
        publicKey: CryptoKey;
        publicKeyBytes: Uint8Array;
    };
    backupKey: CryptoKey;
}

// Options for deriveKeys. `extractable` is the rotation-only escape hatch
// described in ADR-0012 (Backup migration): at the moment of rotation the
// caller re-derives the *old* backup key with extractable=true so it can
// be `subtle.exportKey('raw')`-ed into the chain-link plaintext, then
// dropped. The persisted at-rest backup key in IDB is always non-extractable.
export interface DeriveKeysOptions {
    extractable?: boolean;
}

export async function deriveKeys(
    secret: Uint8Array,
    opts: DeriveKeysOptions = {},
): Promise<DerivedKeys> {
    const authSeed = new Uint8Array(await hkdfDerive(secret, 'auth-v1'));
    const sharingSeed = new Uint8Array(await hkdfDerive(secret, 'sharing-v1'));
    const backupKeyBytes = await hkdfDerive(secret, 'backup-v1');

    // Ed25519 auth keypair
    const authPrivateKey = await crypto.subtle.importKey(
        'pkcs8',
        wrapPkcs8(buf(ED25519_PKCS8_PREFIX), buf(authSeed)),
        { name: 'Ed25519' },
        true,
        ['sign'],
    );
    const authJwk = await crypto.subtle.exportKey('jwk', authPrivateKey);
    // biome-ignore lint/style/noNonNullAssertion: Ed25519 JWK always has x
    const authPublicKeyBytes = base64UrlDecode(authJwk.x!);
    const authPublicKey = await crypto.subtle.importKey(
        'raw',
        buf(authPublicKeyBytes),
        { name: 'Ed25519' },
        true,
        ['verify'],
    );

    // P-256 sharing keypair. Private is non-extractable — JS can deriveBits
    // but cannot exfiltrate the scalar. See ADR-0008 for rationale.
    // Web Crypto's ECDH JWK import requires x,y,d, so we compute the public
    // point via @noble/curves rather than round-tripping through exportKey.
    if (!p256.utils.isValidSecretKey(sharingSeed)) {
        throw new Error('sharing seed out of range for P-256');
    }
    const sharingPublicKeyBytes = p256.getPublicKey(sharingSeed, false); // 0x04 || X(32) || Y(32)
    const sharingPrivateKey = await crypto.subtle.importKey(
        'jwk',
        {
            kty: 'EC',
            crv: 'P-256',
            d: base64UrlEncode(sharingSeed),
            x: base64UrlEncode(sharingPublicKeyBytes.slice(1, 33)),
            y: base64UrlEncode(sharingPublicKeyBytes.slice(33, 65)),
            ext: false,
        },
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        ['deriveBits'],
    );
    const sharingPublicKey = await crypto.subtle.importKey(
        'raw',
        buf(sharingPublicKeyBytes),
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        [],
    );

    // AES-256-GCM backup key. Default non-extractable; rotation re-derives
    // the OLD key with extractable=true once, exports it into a chain link,
    // and discards. See ADR-0012 — Backup migration.
    const backupKey = await crypto.subtle.importKey(
        'raw',
        backupKeyBytes,
        { name: 'AES-GCM' },
        opts.extractable ?? false,
        ['encrypt', 'decrypt'],
    );

    return {
        auth: {
            privateKey: authPrivateKey,
            publicKey: authPublicKey,
            publicKeyBytes: authPublicKeyBytes,
        },
        sharing: {
            privateKey: sharingPrivateKey,
            publicKey: sharingPublicKey,
            publicKeyBytes: sharingPublicKeyBytes,
        },
        backupKey,
    };
}

// ── JCS canonicalization + auth proof ───────────────────────────────
//
// Auth proofs and the rotation continuity signature are signed over their
// RFC 8785 (JCS) canonical bytes rather than JSON.stringify's
// insertion-order output, so the client and the Go server agree on the
// exact byte sequence regardless of key ordering. This is the single
// auth-proof shape — the legacy non-canonical form has been removed.

export function canonicalizeForSign(obj: Record<string, unknown>): Uint8Array {
    const canonical = canonicalize(obj);
    if (canonical === undefined)
        throw new Error('canonicalize returned undefined');
    return enc.encode(canonical);
}

/**
 * Sign the JCS-canonicalized form of a request body with the user's auth
 * private key. Used by the rotate-keys flow (continuity signature, signed
 * by the *old* auth key over the new-credential request body excluding
 * the continuity_signature field itself). Both halves of the rotation
 * agree byte-for-byte on the signed input via JCS — the interop fixture
 * in web/e2e/fixtures/jcs-rotation-vector.* is the regression guard.
 */
export async function signContinuity(
    privateKey: CryptoKey,
    bodyWithoutSig: Record<string, unknown>,
): Promise<Uint8Array> {
    const data = canonicalizeForSign(bodyWithoutSig);
    return new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, buf(data)),
    );
}

export async function signAuthProofV2(
    privateKey: CryptoKey,
    payload: {
        user_id: string;
        device_id: string;
        timestamp: string;
        key_version: number;
    },
): Promise<Uint8Array> {
    const data = canonicalizeForSign(payload);
    return new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, buf(data)),
    );
}

// ── ECIES (ECDH P-256 + HKDF-SHA256 + AES-256-GCM) ────────────────

const ECIES_INFO = enc.encode('atmin.net key share');

export interface ECIESCiphertext {
    ephemeralKey: Uint8Array; // 65 bytes, uncompressed P-256 public key (0x04 || X || Y)
    iv: Uint8Array; // 12 bytes
    ciphertext: Uint8Array;
}

export async function eciesEncrypt(
    recipientPublicKey: CryptoKey,
    plaintext: Uint8Array,
): Promise<ECIESCiphertext> {
    // Ephemeral P-256 keypair
    const ephemeral = (await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveBits'],
    )) as CryptoKeyPair;

    // ECDH (shared secret = x-coordinate, 32 bytes for P-256)
    const shared = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: recipientPublicKey },
        ephemeral.privateKey,
        256,
    );

    // HKDF → AES key
    const hkdfKey = await crypto.subtle.importKey(
        'raw',
        shared,
        'HKDF',
        false,
        ['deriveBits'],
    );
    const aesKeyBytes = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(0) as Bytes,
            info: ECIES_INFO,
        },
        hkdfKey,
        256,
    );
    const aesKey = await crypto.subtle.importKey(
        'raw',
        aesKeyBytes,
        { name: 'AES-GCM' },
        false,
        ['encrypt'],
    );

    // Encrypt
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        aesKey,
        buf(plaintext),
    );

    // Export ephemeral public key
    const ephPub = new Uint8Array(
        await crypto.subtle.exportKey('raw', ephemeral.publicKey),
    );

    return { ephemeralKey: ephPub, iv, ciphertext: new Uint8Array(ct) };
}

export async function eciesDecrypt(
    recipientPrivateKey: CryptoKey,
    { ephemeralKey, iv, ciphertext }: ECIESCiphertext,
): Promise<Uint8Array> {
    // Import ephemeral public key
    const ephPub = await crypto.subtle.importKey(
        'raw',
        buf(ephemeralKey),
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        [],
    );

    // ECDH
    const shared = await crypto.subtle.deriveBits(
        { name: 'ECDH', public: ephPub },
        recipientPrivateKey,
        256,
    );

    // HKDF → AES key
    const hkdfKey = await crypto.subtle.importKey(
        'raw',
        shared,
        'HKDF',
        false,
        ['deriveBits'],
    );
    const aesKeyBytes = await crypto.subtle.deriveBits(
        {
            name: 'HKDF',
            hash: 'SHA-256',
            salt: new Uint8Array(0) as Bytes,
            info: ECIES_INFO,
        },
        hkdfKey,
        256,
    );
    const aesKey = await crypto.subtle.importKey(
        'raw',
        aesKeyBytes,
        { name: 'AES-GCM' },
        false,
        ['decrypt'],
    );

    // Decrypt
    return new Uint8Array(
        await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: buf(iv) },
            aesKey,
            buf(ciphertext),
        ),
    );
}

// ── AES-256-GCM key backup ─────────────────────────────────────────

export interface AESCiphertext {
    iv: Uint8Array; // 12 bytes
    ciphertext: Uint8Array;
}

export async function backupEncrypt(
    backupKey: CryptoKey,
    plaintext: Uint8Array,
): Promise<AESCiphertext> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        backupKey,
        buf(plaintext),
    );
    return { iv, ciphertext: new Uint8Array(ct) };
}

export async function backupDecrypt(
    backupKey: CryptoKey,
    { iv, ciphertext }: AESCiphertext,
): Promise<Uint8Array> {
    return new Uint8Array(
        await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: buf(iv) },
            backupKey,
            buf(ciphertext),
        ),
    );
}

// ── Public key import helpers ───────────────────────────────────────

export async function importSharingPublicKey(
    raw: Uint8Array,
): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'raw',
        buf(raw),
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        [],
    );
}

export async function importEd25519PublicKey(
    raw: Uint8Array,
): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', buf(raw), { name: 'Ed25519' }, true, [
        'verify',
    ]);
}
