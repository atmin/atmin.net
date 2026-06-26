import { useEffect, useState } from 'react';
import { storeGet } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { uploadContacts } from '@/lib/contact-backup';
import {
    loadAllContacts,
    loadConversations,
    type StoredConversation,
    saveContact,
    unreadCounts,
} from '@/lib/db';
import { onInboxUpdated } from '@/lib/inbox-sync';
import { path } from '@/lib/paths';
import { onReadMarkersChanged } from '@/lib/read-markers';

export interface ConversationsState {
    conversations: StoredConversation[];
    contacts: Map<string, string>;
    displayNames: Map<string, string>;
    /** Per-conversation unread incoming-message count (ADR-0026); omits zeros. */
    unread: Map<string, number>;
    serverOk: boolean | null;
    /**
     * True once the first IndexedDB read has resolved. The list is local data,
     * so this flips within a frame of mount — it exists only to suppress the
     * "no conversations" empty state during that read, so a populated account
     * never flashes it on reload.
     */
    hydrated: boolean;
}

export function useConversations(session: Session): ConversationsState {
    const [serverOk, setServerOk] = useState<boolean | null>(null);
    const [conversations, setConversations] = useState<StoredConversation[]>(
        [],
    );
    const [contacts, setContacts] = useState<Map<string, string>>(new Map());
    const [displayNames, setDisplayNames] = useState<Map<string, string>>(
        new Map(),
    );
    const [unread, setUnread] = useState<Map<string, number>>(new Map());
    const [hydrated, setHydrated] = useState(false);

    useEffect(() => {
        fetch('/healthz')
            .then((r) => setServerOk(r.ok))
            .catch(() => setServerOk(false));
    }, []);

    // Hydrate the conversation list straight from IndexedDB on mount. It's
    // purely local data, so it must NOT wait on the Megolm session manager —
    // that only goes live after WASM init + the S3 key-restore round-trips, and
    // gating the list behind it left it blank for seconds on reload. The
    // background inbox sync reconciles afterwards via onInboxUpdated. Keyed on
    // stable session primitives (not the session object, which gets a fresh
    // reference each loadSession) so StrictMode's double-invoke doesn't refire.
    const { userId, token, backupKey, keyVersion } = session;
    useEffect(() => {
        const refresh = async () => {
            const [convs, contactMap, unreadMap] = await Promise.all([
                loadConversations(),
                loadAllContacts(),
                unreadCounts(userId),
            ]);
            setConversations(convs);
            setContacts(contactMap);
            setUnread(unreadMap);
            setHydrated(true);

            // Collect all conversation peer IDs
            const peerIds: string[] = [];
            for (const conv of convs) {
                if (conv.conversationId.startsWith('self:')) continue;
                const parts = conv.conversationId.split(':');
                const peerUserId = parts[1] === userId ? parts[2] : parts[1];
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
                                token,
                                path.profile(uid),
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
                    uploadContacts(token, userId, backupKey, keyVersion).catch(
                        (err) => console.error('Contact backup failed:', err),
                    );
                }
            }
        };

        // A read mark (here or merged from another device) changes only unread
        // counts — recompute those alone, skipping the profile/network refresh.
        const recomputeUnread = async () => {
            setUnread(await unreadCounts(userId));
        };

        // Show cached data immediately, then re-read whenever inbox syncs; a
        // separate light recompute keeps badges current on read-marker changes.
        refresh();
        const offInbox = onInboxUpdated(refresh);
        const offRead = onReadMarkersChanged(recomputeUnread);
        return () => {
            offInbox();
            offRead();
        };
    }, [userId, token, backupKey, keyVersion]);

    return {
        conversations,
        contacts,
        displayNames,
        unread,
        serverOk,
        hydrated,
    };
}
