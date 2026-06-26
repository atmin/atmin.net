/**
 * Cross-device read markers (ADR-0026).
 *
 * A read marker is a per-conversation watermark: the timestamp of the newest
 * message you've seen. It is **self-state**, never a read receipt — it answers
 * "what haven't I seen," and is never signalled to the peer.
 *
 * Markers sync across your devices as a single client-owned, backup-key-
 * encrypted blob at `users/{uid}/read-markers.json` — the same posture as
 * `contacts.json` (the server stores opaque ciphertext, never learning which
 * chats exist or where you've read). The merge is a monotone per-conversation
 * `max()`: each watermark only ever advances, so GET → merge → PUT converges
 * with no server logic and no locking. The watermark is the *message's own
 * timestamp*, so merging is immune to device clock skew.
 *
 * This module holds the blob I/O (mirroring contact-backup.ts), the pure merge,
 * and the orchestration that reconciles local IDB with the remote blob. The
 * local watermarks themselves live on the conversation rows in db.ts.
 */

import { putWithRetry, storeGet, storePresign } from './api';
import type { Session } from './auth';
import { backupDecrypt, backupEncrypt } from './crypto';
import { loadReadMarkers, markConversationRead } from './db';
import {
    parseKeyBackupEnvelope,
    wrapKeyBackupEnvelope,
} from './key-backup-envelope';
import { fetchChain, resolveBackupKey } from './key-chain';
import { path } from './paths';

/** conversationId → read watermark (ms epoch). */
export type Markers = Record<string, number>;

interface ReadMarkersBlob {
    v: 1;
    markers: Markers;
}

/**
 * The CRDT join: per-conversation `max()`. Commutative, associative, and
 * idempotent, so any interleaving of device writes converges to the same
 * result — the highest watermark each conversation has reached on any device.
 */
export function mergeMarkers(a: Markers, b: Markers): Markers {
    const out: Markers = { ...a };
    for (const [cid, ts] of Object.entries(b)) {
        if (ts > (out[cid] ?? 0)) out[cid] = ts;
    }
    return out;
}

/** Encrypt the marker map under the current backup key and PUT the blob. */
export async function uploadReadMarkers(
    token: string,
    userId: string,
    backupKey: CryptoKey,
    keyVersion: number,
    markers: Markers,
): Promise<void> {
    const blob: ReadMarkersBlob = { v: 1, markers };
    const plaintext = new TextEncoder().encode(JSON.stringify(blob));

    const encrypted = await backupEncrypt(backupKey, plaintext);
    const env = wrapKeyBackupEnvelope(
        keyVersion,
        encrypted.iv,
        encrypted.ciphertext,
    );
    const blobBytes = new TextEncoder().encode(JSON.stringify(env));

    const key = path.readMarkers(userId);
    const { presigned_url } = await storePresign(token, key, blobBytes.length);
    await putWithRetry(presigned_url, blobBytes);
}

/**
 * GET + decrypt the remote marker blob. Returns `{}` when the blob doesn't
 * exist yet (first device / never written). After a rotation, a stale blob
 * carries an older `v`; the backup key for it is recovered by walking the key
 * chain (mirroring restoreContacts). A blob written under a *newer* key version
 * than this device knows is skipped — it can't be decrypted yet.
 */
export async function fetchReadMarkers(
    token: string,
    userId: string,
    backupKey: CryptoKey,
    currentVersion: number,
): Promise<Markers> {
    let blob: ArrayBuffer;
    try {
        blob = await storeGet(token, path.readMarkers(userId));
    } catch {
        return {};
    }

    const parsed = parseKeyBackupEnvelope(
        JSON.parse(new TextDecoder().decode(blob)),
    );

    let decryptor = backupKey;
    if (parsed.v !== currentVersion) {
        if (parsed.v > currentVersion) {
            console.warn(
                `read-markers blob written under newer kv ${parsed.v} (current ${currentVersion}); skipping`,
            );
            return {};
        }
        const chain = await fetchChain(token, userId);
        decryptor = await resolveBackupKey(
            userId,
            backupKey,
            currentVersion,
            parsed.v,
            chain,
        );
    }

    const plainBytes = await backupDecrypt(decryptor, {
        iv: parsed.iv,
        ciphertext: parsed.ciphertext,
    });
    const data = JSON.parse(
        new TextDecoder().decode(plainBytes),
    ) as ReadMarkersBlob;
    return data && typeof data.markers === 'object' ? data.markers : {};
}

/**
 * Reconcile local read state with the remote blob (ADR-0026):
 *   1. GET the remote markers (merged from every device).
 *   2. Merge with local — per-conversation `max()`.
 *   3. Apply any merged advances to the local conversation rows (so a chat read
 *      on another device stops showing as unread here).
 *   4. If local is ahead of remote anywhere, PUT the merged blob back.
 *
 * Idempotent and convergent: two devices racing this both re-GET and re-merge,
 * and a write that lands on stale data is healed by the next call. Best-effort
 * on the network — a thrown GET/PUT (offline) leaves local intact; the next
 * online sync flushes. Returns true if any local row advanced from remote, so
 * the caller can refresh badges.
 */
export async function syncReadMarkers(session: Session): Promise<boolean> {
    const remote = await fetchReadMarkers(
        session.token,
        session.userId,
        session.backupKey,
        session.keyVersion,
    );
    const local = await loadReadMarkers();
    const merged = mergeMarkers(local, remote);

    let localAdvanced = false; // a local row moved forward from remote
    let aheadOfRemote = false; // local knows a watermark remote doesn't
    for (const [cid, ts] of Object.entries(merged)) {
        if (ts > (local[cid] ?? 0)) {
            if (await markConversationRead(cid, ts)) localAdvanced = true;
        }
        if (ts > (remote[cid] ?? 0)) aheadOfRemote = true;
    }

    if (aheadOfRemote) {
        await uploadReadMarkers(
            session.token,
            session.userId,
            session.backupKey,
            session.keyVersion,
            merged,
        );
    }
    return localAdvanced;
}

// ── Local change notifications ────────────────────────────────────
//
// Fired when read state changes locally (a chat marked read on open, or a
// remote marker merged in). Distinct from onInboxUpdated — re-reading IDB for a
// badge recompute is cheap, but firing the inbox listeners would trigger their
// network refresh (profile GETs), so the app-icon badge listens here instead.

const listeners = new Set<() => void>();

export function onReadMarkersChanged(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

export function notifyReadMarkersChanged(): void {
    for (const fn of listeners) {
        try {
            fn();
        } catch (err) {
            console.error('read-markers listener threw:', err);
        }
    }
}

// ── Debounced cross-device push ───────────────────────────────────
//
// Marking a chat read advances local state instantly; the blob PUT is coalesced
// so opening five chats in a row is one upload, not five. syncReadMarkers
// GET-merges first, so a debounced push never clobbers another device's writes.

let pushTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleReadMarkerPush(session: Session, delayMs = 3000): void {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => {
        pushTimer = null;
        syncReadMarkers(session)
            .then((advanced) => {
                if (advanced) notifyReadMarkersChanged();
            })
            .catch((err) =>
                console.error('read-marker push failed (will retry):', err),
            );
    }, delayMs);
}

// Test-only: drop subscribers + any pending push between tests.
export function _resetReadMarkers(): void {
    listeners.clear();
    if (pushTimer) {
        clearTimeout(pushTimer);
        pushTimer = null;
    }
}
