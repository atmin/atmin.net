/**
 * Backup-key chain (ADR-0012 — Key chain).
 *
 * `keys/{user_id}/key_chain.json` is an append-only list of links, one
 * per rotation. Each link wraps the older backup key with the newer:
 *
 *   ciphertext = AES-256-GCM(backup_key_to, raw(backup_key_from))
 *
 * The current device always holds `backup_key_M` (M = current
 * key_version). To decrypt a blob written under `v: N` with N < M it
 * walks the chain backwards M → M-1 → … → N, decrypting each link with
 * the next-newer key to recover the next-older one. Resolved
 * intermediate keys land in IDB (`backup_keys_by_version`) so the
 * O(rotations) walk is paid once per device per version.
 *
 * Forward writes — `buildChainLink` + `appendChainLink` — are invoked
 * from the change-password flow (see `useRotateKeys`), not from this
 * module's read path.
 */

import { putWithRetry, storeGet, storePresign } from './api';
import { getBackupKey, putBackupKey } from './db';
import { path } from './paths';

export interface KeyChainLink {
    from: number;
    to: number;
    iv: string; // base64
    ciphertext: string; // base64
}

export interface KeyChain {
    links: KeyChainLink[];
}

function bytesToB64(b: Uint8Array): string {
    return btoa(String.fromCharCode(...b));
}

// Web Crypto's DOM types want BufferSource backed by ArrayBuffer; TS 5.9
// defaults inferences to Uint8Array<ArrayBufferLike>. The cast here is safe
// because the buffer comes straight from a fresh atob-driven Uint8Array.
function b64ToBytes(s: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(atob(s), (c) =>
        c.charCodeAt(0),
    ) as Uint8Array<ArrayBuffer>;
}

/**
 * Fetch the current chain. Absence (404) returns an empty chain —
 * the account has never rotated.
 */
export async function fetchChain(
    token: string,
    userId: string,
): Promise<KeyChain> {
    try {
        const blob = await storeGet(token, path.keyChain(userId));
        const parsed = JSON.parse(new TextDecoder().decode(blob)) as KeyChain;
        if (!parsed || !Array.isArray(parsed.links)) return { links: [] };
        return parsed;
    } catch {
        return { links: [] };
    }
}

/**
 * Wrap `prevKey` with `toKey` and return the new link. The rotating
 * device holds both keys at the moment of rotation (it just re-derived
 * the old key as extractable to build this); after this call they
 * should be dropped from memory.
 */
export async function buildChainLink(
    fromVersion: number,
    toVersion: number,
    prevKey: CryptoKey,
    toKey: CryptoKey,
): Promise<KeyChainLink> {
    const prevBytes = new Uint8Array(
        await crypto.subtle.exportKey('raw', prevKey),
    );
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        toKey,
        prevBytes,
    );
    return {
        from: fromVersion,
        to: toVersion,
        iv: bytesToB64(iv),
        ciphertext: bytesToB64(new Uint8Array(ct)),
    };
}

/**
 * Read the current chain, append the new link, and write it back.
 * Not atomic: a concurrent rotation racing this caller would clobber
 * one of the appends. That race is closed at the rotation flow level
 * — the server's per-uid rotation mutex ensures only one rotation is
 * in flight per account (see ADR-0012 — Concurrency control).
 */
export async function appendChainLink(
    token: string,
    userId: string,
    link: KeyChainLink,
): Promise<void> {
    const current = await fetchChain(token, userId);
    current.links.push(link);
    const body = new TextEncoder().encode(JSON.stringify(current));
    const { presigned_url } = await storePresign(
        token,
        path.keyChain(userId),
        body.length,
    );
    await putWithRetry(presigned_url, body);
}

/**
 * Walk the chain from `currentVersion` back to `targetVersion`,
 * returning the backup key for the target. The walker memoizes each
 * intermediate `(userId, version)` in IDB so subsequent reads don't
 * pay the AES-GCM-decrypt cost again.
 *
 * Throws on a broken chain (missing link in the M → N path) or on
 * `targetVersion > currentVersion` — caller error.
 */
export async function resolveBackupKey(
    userId: string,
    currentKey: CryptoKey,
    currentVersion: number,
    targetVersion: number,
    chain: KeyChain,
): Promise<CryptoKey> {
    if (targetVersion === currentVersion) return currentKey;
    if (targetVersion > currentVersion) {
        throw new Error(
            `key chain: target v${targetVersion} is newer than current v${currentVersion}`,
        );
    }

    // Fast path: the target itself is already memoized from a prior walk.
    const direct = await getBackupKey(userId, targetVersion);
    if (direct) return direct;

    let key = currentKey;
    let version = currentVersion;
    while (version > targetVersion) {
        // Check memo at the next-older version before decrypting the link.
        const memoed = await getBackupKey(userId, version - 1);
        if (memoed) {
            key = memoed;
            version--;
            continue;
        }

        const link = chain.links.find(
            (l) => l.to === version && l.from === version - 1,
        );
        if (!link) {
            throw new Error(
                `key chain: missing link from v${version - 1} to v${version}`,
            );
        }
        const iv = b64ToBytes(link.iv);
        const ct = b64ToBytes(link.ciphertext);
        const prevBytes = new Uint8Array(
            await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct),
        );
        const prevKey = await crypto.subtle.importKey(
            'raw',
            prevBytes,
            { name: 'AES-GCM' },
            false,
            ['encrypt', 'decrypt'],
        );
        await putBackupKey(userId, version - 1, prevKey);
        key = prevKey;
        version--;
    }
    return key;
}
