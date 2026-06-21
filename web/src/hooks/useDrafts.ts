import { useMemo } from 'react';
import { DRAFT_PREFIX } from './useDraft';

// A snapshot of every unsent draft (localStorage, written by useDraft) keyed by
// conversation handle, for the chat-list "Draft:" preview. Read once per mount:
// a draft only changes from inside a chat (ChatView), and returning to the list
// remounts this route (react-router swaps `/` ↔ the chat splat), so the snapshot
// is current whenever the list is shown.
export function useDrafts(): Map<string, string> {
    return useMemo(() => {
        const drafts = new Map<string, string>();
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (!key?.startsWith(DRAFT_PREFIX)) continue;
            const value = localStorage.getItem(key);
            if (value) drafts.set(key.slice(DRAFT_PREFIX.length), value);
        }
        return drafts;
    }, []);
}
