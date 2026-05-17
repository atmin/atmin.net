import { useEffect } from 'react';
import { storeList } from '@/lib/api';
import type { Session } from '@/lib/auth';
import { syncAndPublish } from '@/lib/inbox-sync';
import type { SessionManager } from '@/lib/megolm-session';
import { path } from '@/lib/paths';

export function useInboxSync(
    session: Session | null,
    sessionManager: SessionManager | null,
): void {
    useEffect(() => {
        if (!session || !sessionManager) return;

        const s = session;
        const sm = sessionManager;

        syncAndPublish(s, sm);

        const url = `/v1/events?token=${encodeURIComponent(s.token)}`;
        const events = new EventSource(url);

        events.addEventListener('new_message', () => {
            syncAndPublish(s, sm);
        });

        events.onerror = () => {
            events.close();
            if (navigator.onLine) {
                storeList(s.token, path.inboxLive(s.userId)).catch(() => {});
            }
        };

        return () => events.close();
    }, [session, sessionManager]);
}
