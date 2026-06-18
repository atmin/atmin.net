import { useEffect, useState } from 'react';
import { resolve } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { uploadContacts } from '@/lib/contact-backup';
import { base64UrlDecode } from '@/lib/crypto';
import {
    loadAllContacts,
    loadMessages as loadFromDB,
    saveContact,
} from '@/lib/db';
import { onInboxUpdated } from '@/lib/inbox-sync';
import type { MediaFile } from '@/lib/media';
import type { SessionManager } from '@/lib/megolm-session';
import { conversationId } from '@/lib/messaging';
import { parseInner } from '@/lib/payload';
import { useChatSend } from './useChatSend';

export interface Message {
    id: string;
    text: string;
    timestamp: Date;
    sent: boolean;
    media?: MediaFile;
    // Set by the materializer when an `edit` amendment was applied. Carries the
    // amendment's send time so the UI can surface long-after edits.
    editedAt?: Date;
    // Set when a `delete` amendment was applied; the bubble renders a
    // `[deleted]` placeholder in the original's position.
    deleted?: boolean;
}

interface ParsedRow {
    m: { id: string; text: string; timestamp: Date; fromUser: string };
    p: ReturnType<typeof parseInner>;
}

// Two-pass materializer (docs/specs/mvp-v0.1.md "Materialization", ADR-0014):
// partition originals from amendments, then walk the originals applying each
// one's amendment chain in ULID order. Orphan amendments (no matching original
// in this conversation) are simply left unapplied — they stay in IDB and land
// naturally on a later pass once the original arrives.
function toMessages(
    msgs: { id: string; text: string; timestamp: Date; fromUser: string }[],
    userId: string,
): Message[] {
    // First pass — parse once, partition.
    const amendmentsByTarget = new Map<string, ParsedRow[]>();
    const originals: ParsedRow[] = [];
    for (const m of msgs) {
        const p = parseInner(m.text);
        if (p.kind === 'amendment') {
            const list = amendmentsByTarget.get(p.targetMsgId) ?? [];
            list.push({ m, p });
            amendmentsByTarget.set(p.targetMsgId, list);
        } else if (p.kind !== 'unknown') {
            originals.push({ m, p });
        }
        // 'unknown' (future inner type) → dropped from materialization.
    }

    // Second pass — materialize each original and apply its amendments.
    return originals.map(({ m, p }) => {
        const base: Message = {
            id: m.id,
            text: p.kind === 'text' || p.kind === 'media' ? p.body : '',
            timestamp: m.timestamp,
            sent: m.fromUser === userId,
        };
        if (p.kind === 'media') {
            base.media = {
                url: p.file.url,
                key: base64UrlDecode(p.file.key),
                iv: base64UrlDecode(p.file.iv),
                name: p.file.name,
                size: p.file.size,
                // Optional fields carried through verbatim (absent on legacy).
                ...(p.file.mime !== undefined && { mime: p.file.mime }),
                ...(p.file.width !== undefined && { width: p.file.width }),
                ...(p.file.height !== undefined && { height: p.file.height }),
                ...(p.file.optimized !== undefined && {
                    optimized: p.file.optimized,
                }),
                // Decode the preview's key/iv to bytes, like the full above.
                ...(p.file.preview && {
                    preview: {
                        url: p.file.preview.url,
                        key: base64UrlDecode(p.file.preview.key),
                        iv: base64UrlDecode(p.file.preview.iv),
                        width: p.file.preview.width,
                        height: p.file.preview.height,
                    },
                }),
            };
        }

        const chain = (amendmentsByTarget.get(m.id) ?? [])
            .slice()
            .sort((a, b) => (a.m.id < b.m.id ? -1 : a.m.id > b.m.id ? 1 : 0));
        for (const { m: am, p: a } of chain) {
            if (a.kind !== 'amendment') continue;
            // Authorization: only the original's sender may amend it.
            if (am.fromUser !== m.fromUser) continue;
            if (a.action === 'delete') {
                base.deleted = true;
                base.text = '';
                base.media = undefined;
                break; // terminal — delete trumps any later amendment
            }
            if (a.action === 'edit') {
                if (a.body === undefined) continue; // malformed edit
                // Pure-media message (no caption): edit is malformed, ignore.
                if (base.media && base.text === '') continue;
                base.text = a.body;
                base.editedAt = am.timestamp;
            }
            // Unknown action → silently skipped.
        }
        return base;
    });
}

export interface ChatState {
    messages: Message[];
    loading: boolean;
    sending: boolean;
    online: boolean;
    encryptionReady: boolean;
    chatTitle: string;
    sendMessage: (text: string) => Promise<void>;
    sendMedia: (file: File, caption?: string) => Promise<void>;
}

export function useChat(
    handle: string | undefined,
    session: Session,
    sessionManager: SessionManager | null,
): ChatState {
    const isSaved = handle === 'saved';

    const [messages, setMessages] = useState<Message[]>([]);
    const [loading, setLoading] = useState(true);
    const [convId, setConvId] = useState<string | null>(null);
    const [chatTitle, setChatTitle] = useState(
        isSaved ? 'Saved Messages' : (handle ?? ''),
    );

    const { sending, online, sendText, sendMedia } = useChatSend(
        handle,
        isSaved,
        session,
        sessionManager,
    );

    // Resolve conversation ID from handle
    useEffect(() => {
        if (isSaved) {
            setConvId(conversationId(session.userId, session.userId));
            return;
        }
        if (!handle) return;

        resolve(handle)
            .then(async (res) => {
                // The chat-open path only proceeds for live accounts;
                // not_found and released (post-deletion cooldown) both
                // log and fall through — there's no live counterparty
                // to message. UI surfacing of the distinction is a
                // polish follow-up.
                if (res.status !== 'live') {
                    console.error(
                        `cannot open chat: handle "${handle}" is ${res.status}`,
                    );
                    return;
                }
                if (res.display_name) setChatTitle(res.display_name);
                await saveContact(res.user_id, handle);
                uploadContacts(
                    session.token,
                    session.userId,
                    session.backupKey,
                    session.keyVersion,
                ).catch((err) => console.error('Contact backup failed:', err));
                setConvId(conversationId(session.userId, res.user_id));
            })
            .catch(async (err) => {
                // Offline / handle server unreachable: fall back to the
                // IDB-cached contact so previously-synced messages still
                // render. A handle never resolved before genuinely cannot
                // be opened offline.
                if (!(err instanceof TypeError)) {
                    console.error('Failed to resolve handle:', err);
                    return;
                }
                const contacts = await loadAllContacts();
                for (const [userId, h] of contacts) {
                    if (h === handle) {
                        setConvId(conversationId(session.userId, userId));
                        return;
                    }
                }
            });
    }, [handle, isSaved, session]);

    // Read from IndexedDB immediately on convId change, then subscribe to
    // inbox updates. useInboxSync (in app.tsx) owns the SSE connection and
    // calls syncAndPublish; we just re-read IDB whenever it notifies us.
    useEffect(() => {
        if (!convId) return;

        const refresh = async () => {
            try {
                const all = await loadFromDB(session.userId);
                const filtered = all
                    .filter((m) => m.conversationId === convId)
                    .map((m) => ({ ...m, timestamp: new Date(m.timestamp) }));
                setMessages(toMessages(filtered, session.userId));
            } catch (err) {
                console.error('Failed to load messages from IDB:', err);
            } finally {
                setLoading(false);
            }
        };

        refresh();
        return onInboxUpdated(refresh);
    }, [convId, session.userId]);

    return {
        messages,
        loading,
        sending,
        online,
        encryptionReady: !!sessionManager,
        chatTitle,
        sendMessage: sendText,
        sendMedia,
    };
}
