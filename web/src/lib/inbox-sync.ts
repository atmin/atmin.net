// Single owner of inbox sync + change notifications.
//
// Why this module exists: useConversations and useChat both used to call
// fetchMessages independently. Each one advanced cursors and opened its own
// SSE connection. When two callers raced on the same data, the second often
// saw an empty inbox (cursor advanced past it by the first), leaving the
// user stuck on "No messages yet". See the corrupt-blob investigation in
// 2026-05 — that flake was the visible symptom.
//
// Now every sync goes through syncAndPublish: it calls syncMessages, persists
// the results, and then fans out to in-process listeners. useInboxSync is the
// only place that triggers a sync (on mount + SSE + after send), and
// useConversations/useChat are passive consumers that re-read IndexedDB when
// notified.

import type { Session } from './auth';
import { markArchiveIngested, saveMessages } from './db';
import type { SessionManager } from './megolm-session';
import { syncMessages } from './messaging';
import { syncReadMarkers } from './read-markers';

const listeners = new Set<() => void>();

/**
 * Subscribe to inbox updates. Returns an unsubscribe function.
 *
 * Listeners fire after syncAndPublish has persisted messages to IndexedDB,
 * so subscribers can safely re-read from the DB and expect fresh data.
 */
export function onInboxUpdated(fn: () => void): () => void {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
}

/**
 * Fetch the inbox, persist new messages, then notify subscribers.
 *
 * Errors from syncMessages are logged (not thrown) so a transient network
 * failure does not break the calling effect. Listeners are still notified
 * on success so consumers can refresh from IndexedDB.
 */
export async function syncAndPublish(
    session: Session,
    sessionManager: SessionManager,
): Promise<void> {
    let synced: Awaited<ReturnType<typeof syncMessages>>;
    try {
        synced = await syncMessages(
            session.token,
            session.userId,
            session.sharingPrivateKey,
            sessionManager,
            session.backupKey,
            session.keyVersion,
        );
    } catch (err) {
        console.error('Inbox sync failed:', err);
        return;
    }

    if (synced.messages.length > 0) {
        try {
            await saveMessages(session.userId, synced.messages);
        } catch (err) {
            console.error('Saving synced messages failed:', err);
            return;
        }
    }

    // Messages are now durably persisted — only now is it safe to record their
    // archives as ingested so the next sync skips re-downloading them. Marking
    // before this point (or on a saveMessages failure) would risk skipping an
    // archive whose messages never landed. Best-effort: a failure here costs
    // only a future re-download, never a lost message.
    for (const key of synced.ingestedCandidates) {
        try {
            await markArchiveIngested(key);
        } catch (err) {
            console.error(`Failed to mark archive ingested ${key}:`, err);
        }
    }

    // Reconcile read markers with the cross-device blob (ADR-0026): a chat read
    // on another device stops showing unread here, and any local read this
    // device made offline is pushed up. Best-effort — a failure (offline) costs
    // only a deferred reconcile, never local state; the listeners below still
    // fire so badges reflect freshly synced messages.
    try {
        await syncReadMarkers(session);
    } catch (err) {
        console.error('Read-marker sync failed:', err);
    }

    for (const fn of listeners) {
        try {
            fn();
        } catch (err) {
            console.error('Inbox listener threw:', err);
        }
    }
}

// Test-only: drop all subscribers between tests so module state does not
// bleed across cases. Not exported through the package surface intentionally.
export function _resetInboxListeners(): void {
    listeners.clear();
}
