/**
 * Web Crypto utilities for atmin.net key management.
 *
 * - HKDF-SHA256 key derivation from backup secret
 * - Ed25519 auth proofs (sign/verify)
 * - ECIES key share encryption (X25519 + HKDF + AES-256-GCM)
 * - AES-256-GCM key backup encryption
 *
 * Only Megolm uses WASM (vodozemac). Everything here is browser-native Web Crypto.
 */

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

const X25519_PKCS8_PREFIX: Bytes = new Uint8Array([
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x6e,
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

export async function deriveKeys(secret: Uint8Array): Promise<DerivedKeys> {
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

    // X25519 sharing keypair
    const sharingPrivateKey = await crypto.subtle.importKey(
        'pkcs8',
        wrapPkcs8(buf(X25519_PKCS8_PREFIX), buf(sharingSeed)),
        { name: 'X25519' },
        true,
        ['deriveBits'],
    );
    const sharingJwk = await crypto.subtle.exportKey('jwk', sharingPrivateKey);
    // biome-ignore lint/style/noNonNullAssertion: X25519 JWK always has x
    const sharingPublicKeyBytes = base64UrlDecode(sharingJwk.x!);
    const sharingPublicKey = await crypto.subtle.importKey(
        'raw',
        buf(sharingPublicKeyBytes),
        { name: 'X25519' },
        true,
        [],
    );

    // AES-256-GCM backup key
    const backupKey = await crypto.subtle.importKey(
        'raw',
        backupKeyBytes,
        { name: 'AES-GCM' },
        false,
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

// ── Ed25519 auth proof ──────────────────────────────────────────────

export async function signAuthProof(
    privateKey: CryptoKey,
    payload: { user_id: string; device_id: string; timestamp: string },
): Promise<Uint8Array> {
    const data = enc.encode(JSON.stringify(payload));
    return new Uint8Array(
        await crypto.subtle.sign({ name: 'Ed25519' }, privateKey, data),
    );
}

export async function verifyAuthProof(
    publicKey: CryptoKey,
    payload: { user_id: string; device_id: string; timestamp: string },
    signature: Uint8Array,
): Promise<boolean> {
    const data = enc.encode(JSON.stringify(payload));
    return crypto.subtle.verify(
        { name: 'Ed25519' },
        publicKey,
        buf(signature),
        data,
    );
}

// ── ECIES (X25519 + HKDF-SHA256 + AES-256-GCM) ────────────────────

const ECIES_INFO = enc.encode('atmin.net key share');

export interface ECIESCiphertext {
    ephemeralKey: Uint8Array; // 32 bytes, X25519 public key
    iv: Uint8Array; // 12 bytes
    ciphertext: Uint8Array;
}

export async function eciesEncrypt(
    recipientPublicKey: CryptoKey,
    plaintext: Uint8Array,
): Promise<ECIESCiphertext> {
    // Ephemeral X25519 keypair
    const ephemeral = (await crypto.subtle.generateKey(
        { name: 'X25519' },
        true,
        ['deriveBits'],
    )) as CryptoKeyPair;

    // ECDH
    const shared = await crypto.subtle.deriveBits(
        { name: 'X25519', public: recipientPublicKey },
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
        { name: 'X25519' },
        false,
        [],
    );

    // ECDH
    const shared = await crypto.subtle.deriveBits(
        { name: 'X25519', public: ephPub },
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

export async function importX25519PublicKey(
    raw: Uint8Array,
): Promise<CryptoKey> {
    return crypto.subtle.importKey(
        'raw',
        buf(raw),
        { name: 'X25519' },
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
