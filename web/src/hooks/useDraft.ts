import { useEffect, useState } from 'react';

export const DRAFT_PREFIX = 'atmin:draft:';
const DRAFT_KEY = (handle: string) => `${DRAFT_PREFIX}${handle}`;

// Persist an unsent message draft per conversation across reloads (including
// PWA service-worker auto-updates). The API mirrors useState<string> so the
// route swaps it in for the old local input state with no other changes.
// Writing '' clears the stored key, so the existing setInputValue('') after a
// successful send doubles as the clear — no separate clear() needed. The
// `atmin:draft:` prefix is what useSWUpdate gates auto-reload on.
export function useDraft(handle: string): [string, (v: string) => void] {
    const [value, setValueState] = useState(
        () => localStorage.getItem(DRAFT_KEY(handle)) ?? '',
    );

    // The route reuses the same ChatView across /:handle navigations, so the
    // lazy initializer alone won't refresh the value — reload on handle change.
    useEffect(() => {
        setValueState(localStorage.getItem(DRAFT_KEY(handle)) ?? '');
    }, [handle]);

    const setValue = (v: string) => {
        setValueState(v);
        if (v) localStorage.setItem(DRAFT_KEY(handle), v);
        else localStorage.removeItem(DRAFT_KEY(handle));
    };

    return [value, setValue];
}
