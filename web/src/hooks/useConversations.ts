import { useEffect, useState } from 'react';
import { fetchMessages, storeGet } from '@/lib/api';
import type { Session } from '@/lib/auth';
import {
    loadAllContacts,
    loadConversations,
    type StoredConversation,
    saveContact,
    saveMessages,
} from '@/lib/db';
import type { SessionManager } from '@/lib/megolm-session';

export interface ConversationsState {
    conversations: StoredConversation[];
    contacts: Map<string, string>;
    serverOk: boolean | null;
}

export function useConversations(
    session: Session,
    sessionManager: SessionManager | null,
): ConversationsState {
    const [serverOk, setServerOk] = useState<boolean | null>(null);
    const [conversations, setConversations] = useState<StoredConversation[]>(
        [],
    );
    const [contacts, setContacts] = useState<Map<string, string>>(new Map());

    useEffect(() => {
        fetch('/healthz')
            .then((r) => setServerOk(r.ok))
            .catch(() => setServerOk(false));
    }, []);

    // Load conversations + contacts from IndexedDB, then sync from server
    useEffect(() => {
        if (!sessionManager) return;

        const refresh = async () => {
            const [convs, contactMap] = await Promise.all([
                loadConversations(),
                loadAllContacts(),
            ]);
            setConversations(convs);
            setContacts(contactMap);

            // Resolve unknown peer handles from server profiles
            const unknownPeers: string[] = [];
            for (const conv of convs) {
                if (conv.conversationId.startsWith('self:')) continue;
                const parts = conv.conversationId.split(':');
                const peerUserId =
                    parts[1] === session.userId ? parts[2] : parts[1];
                if (!contactMap.has(peerUserId)) {
                    unknownPeers.push(peerUserId);
                }
            }
            if (unknownPeers.length > 0) {
                const resolved = new Map(contactMap);
                await Promise.all(
                    unknownPeers.map(async (uid) => {
                        try {
                            const buf = await storeGet(
                                session.token,
                                `users/${uid}/profile.json`,
                            );
                            const profile = JSON.parse(
                                new TextDecoder().decode(buf),
                            );
                            if (profile.invite_handle) {
                                resolved.set(uid, profile.invite_handle);
                                await saveContact(uid, profile.invite_handle);
                            }
                        } catch {
                            // Profile not found — keep userId fallback
                        }
                    }),
                );
                setContacts(resolved);
            }
        };

        // Show cached data immediately
        refresh();

        // Background sync: fetch all messages, save to DB, then refresh
        const sync = async () => {
            try {
                const synced = await fetchMessages(
                    session.token,
                    session.userId,
                    session.sharingPrivateKey,
                    sessionManager,
                );
                if (synced.length > 0) {
                    await saveMessages(session.userId, synced);
                    await refresh();
                }
            } catch (err) {
                console.error('Sync failed:', err);
            }
        };
        sync();

        // SSE: refresh on new messages
        const url = `/v1/events?token=${encodeURIComponent(session.token)}`;
        const events = new EventSource(url);
        events.addEventListener('new_message', () => {
            sync();
        });

        return () => events.close();
    }, [session, sessionManager]);

    return { conversations, contacts, serverOk };
}
