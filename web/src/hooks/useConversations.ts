import { useEffect, useState } from 'react';
import { fetchMessages, storeGet } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { uploadContacts } from '@/lib/contact-backup';
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
    displayNames: Map<string, string>;
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
    const [displayNames, setDisplayNames] = useState<Map<string, string>>(
        new Map(),
    );

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

            // Collect all conversation peer IDs
            const peerIds: string[] = [];
            for (const conv of convs) {
                if (conv.conversationId.startsWith('self:')) continue;
                const parts = conv.conversationId.split(':');
                const peerUserId =
                    parts[1] === session.userId ? parts[2] : parts[1];
                peerIds.push(peerUserId);
            }

            // Refresh handles and display names from server profiles
            if (peerIds.length > 0) {
                const resolvedContacts = new Map(contactMap);
                const resolvedNames = new Map<string, string>();
                let contactsChanged = false;
                await Promise.all(
                    peerIds.map(async (uid) => {
                        try {
                            const buf = await storeGet(
                                session.token,
                                `users/${uid}/profile.json`,
                            );
                            const profile = JSON.parse(
                                new TextDecoder().decode(buf),
                            );
                            // Save handle in contacts (for routing)
                            if (
                                profile.handle &&
                                resolvedContacts.get(uid) !== profile.handle
                            ) {
                                resolvedContacts.set(uid, profile.handle);
                                await saveContact(uid, profile.handle);
                                contactsChanged = true;
                            }
                            // Track display_name separately (for rendering)
                            if (profile.display_name) {
                                resolvedNames.set(uid, profile.display_name);
                            }
                        } catch {
                            // Profile not found — keep existing contact or userId fallback
                        }
                    }),
                );
                setDisplayNames(resolvedNames);
                if (contactsChanged) {
                    setContacts(resolvedContacts);
                    uploadContacts(
                        session.token,
                        session.userId,
                        session.backupKey,
                    ).catch((err) =>
                        console.error('Contact backup failed:', err),
                    );
                }
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

    return { conversations, contacts, displayNames, serverOk };
}
